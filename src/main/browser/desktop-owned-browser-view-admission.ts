import type { Session, WebContents, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'

export type DesktopOwnedBrowserViewIdentity = {
  browserPageId: string
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  rendererWebContentsId: number
}

export type DesktopOwnedBrowserViewRecord = DesktopOwnedBrowserViewIdentity & {
  view: WebContentsView
  webContents: WebContents
  session: Session
  generation: string
}

const mintedRecords = new WeakSet<object>()

export class DesktopOwnedBrowserViewAdmissionError extends Error {
  constructor(
    message: string,
    readonly cleanup: Promise<void>
  ) {
    super(message)
  }
}

export function isDesktopOwnedBrowserViewRecord(
  value: unknown
): value is DesktopOwnedBrowserViewRecord {
  return typeof value === 'object' && value !== null && mintedRecords.has(value)
}

export type DesktopOwnedBrowserViewAdmissionDependencies = {
  isKnownPartition: (sessionProfileId: string | null) => string | null
  getSession: (partition: string) => Session
  createView: (partition: string) => WebContentsView
  attachPolicies: (webContents: WebContents) => void
}

export class DesktopOwnedBrowserViewAdmission {
  constructor(private readonly dependencies: DesktopOwnedBrowserViewAdmissionDependencies) {}

  create(identity: DesktopOwnedBrowserViewIdentity): DesktopOwnedBrowserViewRecord {
    const partition = this.dependencies.isKnownPartition(identity.sessionProfileId)
    if (!partition) {
      throw new Error('Desktop-owned browser view requires a known session profile')
    }
    const view = this.dependencies.createView(partition)
    const webContents = view.webContents
    try {
      if (
        webContents.isDestroyed() ||
        webContents.session !== this.dependencies.getSession(partition)
      ) {
        throw new Error('Desktop-owned browser view session does not match its approved partition')
      }
      this.dependencies.attachPolicies(webContents)
      const record = Object.freeze({
        ...identity,
        view,
        webContents,
        session: webContents.session,
        generation: randomUUID()
      })
      mintedRecords.add(record)
      return record
    } catch (error) {
      const cleanup = webContents.isDestroyed()
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            webContents.once('destroyed', resolve)
            webContents.close()
          })
      throw new DesktopOwnedBrowserViewAdmissionError(
        error instanceof Error ? error.message : String(error),
        cleanup
      )
    }
  }
}
