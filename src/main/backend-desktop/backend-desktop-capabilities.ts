import {
  BrowserWindow,
  MessageChannelMain,
  type IpcMainInvokeEvent,
  type UtilityProcess,
  type WebContents,
  type WebFrameMain
} from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentTokenUsageDailySchema } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { claudeProfileTranscriptDirs } from '../claude-usage/transcript-file-discovery'
import { readUsageWorktreeCatalog } from '../usage/worktree-attribution/usage-worktree-metadata'
import { isTelemetryEnabled } from '../telemetry/client'
import { captureAgentTokenUsageDaily } from '../telemetry/agent-token-usage-capture'
import type { UsageWorktreeSource } from '../usage/worktree-attribution/usage-worktree-metadata'
import { currentWorkerEntryLayout } from '../worker-threads/worker-thread-entry-path'
import { isRendererDocumentNavigation } from '../window/security/renderer-document-navigation'
import {
  BACKEND_PORT_DELIVERY,
  type BackendConnectionPurpose,
  type BackendDocumentAdmission,
  type BackendDocumentRole,
  type BackendPortDelivery
} from '../../shared/backend/backend-service-contract'

/** The trusted renderer page this document is, or null when it may not hold a backend port. */
export function backendDocumentRole(contents: WebContents): BackendDocumentRole | null {
  if (
    contents.isDestroyed() ||
    contents.getType() !== 'window' ||
    !BrowserWindow.fromWebContents(contents)
  ) {
    return null
  }
  const url = contents.getURL()
  const layout = currentWorkerEntryLayout(__dirname)
  const roots = process.env.ELECTRON_RENDERER_URL
    ? [process.env.ELECTRON_RENDERER_URL]
    : ['index.html', 'space.html', 'popout.html'].map(
        (name) => pathToFileURL(join(layout.moduleDir, '../renderer', name)).href
      )
  if (!roots.some((root) => isRendererDocumentNavigation(root, url))) {
    return null
  }
  const page = new URL(url).pathname.split('/').at(-1)
  return page === 'space.html' ? 'space' : page === 'popout.html' ? 'popout' : 'main'
}

export function createBackendDesktopCapabilities(
  store: UsageWorktreeSource
): (method: string, params: unknown) => Promise<unknown> {
  return async (method, params) => {
    if (method === 'usage.catalog') {
      return readUsageWorktreeCatalog(store)
    }
    if (method === 'usage.claudeProfileDirs') {
      return claudeProfileTranscriptDirs()
    }
    if (method === 'usage.telemetry.enabled') {
      return isTelemetryEnabled()
    }
    if (method === 'usage.telemetry.captureDaily') {
      return captureAgentTokenUsageDaily(agentTokenUsageDailySchema.parse(params))
    }
    throw new Error('This desktop capability is not supported.')
  }
}

/** Validates a renderer's port request; only a trusted page's main frame may hold a backend port. */
export function admitBackendPortRequest(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  token: unknown,
  purpose: unknown
): {
  sender: WebContents
  senderFrame: WebFrameMain
  role: BackendDocumentRole
  token: string
  purpose: BackendConnectionPurpose
} {
  if (
    typeof token !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    (purpose !== 'demand' && purpose !== 'recovery')
  ) {
    throw new Error('Invalid backend connection request.')
  }
  const { sender, senderFrame } = event
  const role = senderFrame && senderFrame === sender.mainFrame && backendDocumentRole(sender)
  if (!senderFrame || !role) {
    throw new Error('This document cannot connect to Orca.')
  }
  return { sender, senderFrame, role, token, purpose }
}

/** Hands one end to the backend bound to the document main minted, the other to that document. */
export function deliverBackendDocumentPort(
  child: Pick<UtilityProcess, 'postMessage'>,
  document: BackendDocument,
  incarnation: string
): void {
  const { port1, port2 } = new MessageChannelMain()
  const admission: BackendDocumentAdmission = {
    type: 'client',
    incarnation,
    document: { id: document.id, role: document.role }
  }
  child.postMessage(admission, [port1])
  const delivery: BackendPortDelivery = { token: document.token, incarnation }
  document.frame.postMessage(BACKEND_PORT_DELIVERY, delivery, [port2])
}

/** One admitted renderer document; `id` is minted here and is what the backend binds a port to. */
export type BackendDocument = {
  contents: WebContents
  frame: WebFrameMain
  token: string
  id: string
  role: BackendDocumentRole
  retire(): void
}

export function trackBackendDocument(
  documents: Map<number, BackendDocument>,
  contents: WebContents,
  frame: WebFrameMain,
  admission: { token: string; role: BackendDocumentRole },
  retireDocument: (id: string) => void
): BackendDocument {
  documents.get(contents.id)?.retire()
  const document: BackendDocument = {
    contents,
    frame,
    ...admission,
    id: randomUUID(),
    retire: () => {}
  }
  const retire = (): void => {
    if (documents.get(contents.id) !== document) {
      return
    }
    documents.delete(contents.id)
    retireDocument(document.id)
    contents.off('did-frame-navigate', navigation)
    contents.off('destroyed', retire)
  }
  const navigation = (
    _event: unknown,
    _url: string,
    _httpCode: number,
    _httpStatus: string,
    mainFrame: boolean
  ): void => {
    if (mainFrame) {
      retire()
    }
  }
  document.retire = retire
  documents.set(contents.id, document)
  contents.on('did-frame-navigate', navigation)
  contents.once('destroyed', retire)
  return document
}

export const BACKEND_IDLE_STOP_MS = 2 * 60_000

/** Schedules one-shot idle teardown when no renderer documents or control calls remain. */
export class BackendIdleStopTimer {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly delayMs = BACKEND_IDLE_STOP_MS) {}

  schedule(onIdle: () => void): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = undefined
      onIdle()
    }, this.delayMs)
    this.timer.unref?.()
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}

/** Admits a renderer port request, ensures the backend is ready, and delivers the bound MessagePort. */
export async function handleBackendPortRequest(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  token: unknown,
  purpose: unknown,
  deps: {
    documents: Map<number, BackendDocument>
    isDesiredRunning: () => boolean
    onActivity: () => void
    onDocumentRetired: (documentId: string) => void
    acquireReady: (purpose: BackendConnectionPurpose) => {
      ready: Promise<void> | null
      child: UtilityProcess | null
    }
    getCurrentChild: () => UtilityProcess | null
    getIncarnation: () => string | undefined
  }
): Promise<string> {
  const admitted = admitBackendPortRequest(event, token, purpose)
  const { sender, senderFrame, role } = admitted
  deps.onActivity()
  const document = trackBackendDocument(
    deps.documents,
    sender,
    senderFrame,
    { token: admitted.token, role },
    deps.onDocumentRetired
  )
  if (!deps.isDesiredRunning()) {
    throw new Error('Orca is shutting down.')
  }
  const { ready, child } = deps.acquireReady(admitted.purpose)
  if (!ready) {
    throw new Error('Usage is unavailable. Try refreshing the usage view.')
  }
  await ready
  const incarnation = deps.getIncarnation()
  if (
    deps.documents.get(sender.id) !== document ||
    !deps.isDesiredRunning() ||
    !child ||
    deps.getCurrentChild() !== child ||
    !incarnation ||
    sender.isDestroyed() ||
    sender.mainFrame !== senderFrame
  ) {
    throw new Error('The document was replaced before Orca connected.')
  }
  deliverBackendDocumentPort(child, document, incarnation)
  return document.token
}

/** Cleanly closes the control RPC channel and kills the backend child if it does not exit in time. */
export async function stopBackendUtilityChild(args: {
  child: UtilityProcess | null
  control: { close(): void } | null
  exited: Promise<void>
  isCurrentChild: (child: UtilityProcess) => boolean
  deadlineMs: number
}): Promise<void> {
  if (!args.child) {
    return
  }
  const child = args.child
  const deadline = setTimeout(() => {
    if (args.isCurrentChild(child)) {
      child.kill()
    }
  }, args.deadlineMs)
  args.control?.close()
  await args.exited
  clearTimeout(deadline)
}

export function terminateBackendChild(
  child: UtilityProcess,
  control: { close(): void } | null
): void {
  control?.close()
  try {
    child.kill()
  } catch {}
}
