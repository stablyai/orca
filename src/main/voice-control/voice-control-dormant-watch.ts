import { COMPLETION_MESSAGE_TYPE, type ControlMailboxMessage } from './voice-control-reply-pump'
import type { VoiceControlSessionBackend } from './voice-control-session-backend'

/**
 * Wake-on-reply bookkeeping: the watched run mailboxes of ended sessions with outstanding
 * work, plus the replies that arrived while no session was live. A watcher stays armed
 * until every pane outstanding at stop has reported completion — disarming on the first
 * batch stranded later replies in a mailbox no live session reads (each session opens its
 * own run). One watcher per run; a later session's run never evicts another run's watch.
 */
export class VoiceControlDormantWatch {
  private readonly watchers = new Map<string, { watcher: { stop(): void }; pending: Set<string> }>()
  /** Replies stashed while no session was live — spoken by the next session's start. */
  private pendingWake: ControlMailboxMessage[] = []

  constructor(
    private readonly deps: {
      openWatcher?: (
        runId: string,
        onMessages: (messages: ControlMailboxMessage[]) => void
      ) => { stop(): void }
      /** Asks the owner window to restart voice control so a pending reply gets spoken. */
      emitWakeForReply?: () => void
      /** The live session's backend, when one exists — old-run mail is handed to it. */
      getLiveBackend: () => VoiceControlSessionBackend | null
    }
  ) {}

  /** Arms a watcher on an ended session's run mailbox; a same-run re-arm replaces. */
  watch(runId: string, pendingPanes: string[]): void {
    if (!this.deps.openWatcher) {
      return
    }
    this.watchers.get(runId)?.watcher.stop()
    const watcher = this.deps.openWatcher(runId, (messages) => this.onMail(runId, messages))
    this.watchers.set(runId, { watcher, pending: new Set(pendingPanes) })
  }

  /** Replies a starting session should speak; drains the stash. */
  consumeWakeMessages(): ControlMailboxMessage[] {
    return this.pendingWake.splice(0)
  }

  private onMail(runId: string, messages: ControlMailboxMessage[]): void {
    const entry = this.watchers.get(runId)
    if (!entry) {
      return
    }
    // A completion report settles that pane's follow-through; progress mail must not
    // disarm the watcher — the completion may still be coming.
    for (const message of messages) {
      if (message.senderPaneKey && message.type === COMPLETION_MESSAGE_TYPE) {
        entry.pending.delete(message.senderPaneKey)
      }
    }
    if (entry.pending.size === 0) {
      entry.watcher.stop()
      this.watchers.delete(runId)
    }
    const liveBackend = this.deps.getLiveBackend()
    if (liveBackend) {
      // A session is already running — it speaks and records the replies like its own
      // mail; its pump watches a different run's mailbox and cannot see these.
      liveBackend.ingestDormantMail(messages)
      return
    }
    this.pendingWake.push(...messages)
    this.deps.emitWakeForReply?.()
  }
}
