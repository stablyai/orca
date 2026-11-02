import type { AutomationRun } from '../../shared/automations-types'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'
import type { AutomationRendererChannel } from './automation-dispatch-request'

/** A run handed to the renderer, which alone can move it off `dispatching`. */
export type RendererDispatchHandoff = {
  automationId: string
  runId: string
  dispatchToken: string
  /** Settles the run after its document is gone; `received`: that document got the request. */
  recover: (received: boolean) => Promise<AutomationRun>
}

type OutstandingHandoff = RendererDispatchHandoff & {
  documentId: string | null
  received: boolean
}

type AutomationLaneRunner = <T>(automationId: string, operation: () => Promise<T>) => Promise<T>

/** The renderer runs are handed to, and the hand-offs a reload would strand as `dispatching`. */
export class RendererDispatchLink {
  private webContents: AutomationRendererChannel | null = null
  private ready = false
  private documentId: string | null = null
  private readonly outstanding = new Map<string, OutstandingHandoff>()
  private readonly runInLane: AutomationLaneRunner

  constructor(runInLane: AutomationLaneRunner) {
    this.runInLane = runInLane
  }

  attach(webContents: AutomationRendererChannel | null): void {
    this.webContents = webContents
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }

  /** The renderer to dispatch to, or null while none is attached and ready. */
  current(): AutomationRendererChannel | null {
    const webContents = this.webContents
    return webContents && !webContents.isDestroyed() && this.ready ? webContents : null
  }

  /** A repeat call from one document is a no-op; a new document recovers what the last one left. */
  markReady(documentId?: string): void {
    this.ready = true
    if (!documentId || documentId === this.documentId) {
      return
    }
    this.documentId = documentId
    for (const handoff of this.outstanding.values()) {
      if (handoff.documentId === documentId) {
        continue
      }
      this.outstanding.delete(handoff.runId)
      void this.runInLane(handoff.automationId, () => handoff.recover(handoff.received)).catch(
        (error: unknown) => {
          if (!(error instanceof AutomationDispatchCancelledError)) {
            console.error(
              '[automations] failed to recover a renderer hand-off:',
              handoff.runId,
              error
            )
          }
        }
      )
    }
  }

  track(handoff: RendererDispatchHandoff): void {
    this.outstanding.set(handoff.runId, {
      ...handoff,
      documentId: this.documentId,
      received: false
    })
  }

  markReceived(runId: string, dispatchToken: string): void {
    const handoff = this.outstanding.get(runId)
    if (handoff?.dispatchToken === dispatchToken) {
      handoff.received = true
    }
  }

  /** Any result reported for the run means the renderer answered the hand-off. */
  settle(runId: string): void {
    this.outstanding.delete(runId)
  }
}
