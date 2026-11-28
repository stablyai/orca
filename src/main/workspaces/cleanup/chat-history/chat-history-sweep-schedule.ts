import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import type {
  WorkspaceCleanupRun,
  WorkspaceCleanupRunTrigger
} from '../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { deleteChatHistoryOfDeletedWorkspaces } from './deleted-workspace-chat-history'
import { reportDeletedChatsSweep } from '../../../telemetry/deleted-chats-telemetry'

// Listing every transcript costs a stat and a cache read per file, so hourly runs sweep chats less often.
const HOURLY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/** When a cleanup run also sweeps chat history of deleted workspaces, and the sweep itself. */
export class ChatHistorySweepSchedule {
  private lastSweptAt = 0

  constructor(private readonly store: RuntimeStore) {}

  /** Which parts are on: turning on another part sweeps again, even while one already was. */
  enabledParts(): ReadonlySet<'orca-chats' | 'transcripts'> {
    const settings = this.store.getSettings()
    const parts = new Set<'orca-chats' | 'transcripts'>()
    if (settings.deleteOrcaChatsWithWorkspace === true) {
      parts.add('orca-chats')
    }
    if (settings.deleteAgentTranscriptsWithWorkspace === true) {
      parts.add('transcripts')
    }
    return parts
  }

  isOn(): boolean {
    return this.enabledParts().size > 0
  }

  isDue(trigger: WorkspaceCleanupRunTrigger, now: number): boolean {
    return (
      this.isOn() && (trigger !== 'hourly' || now - this.lastSweptAt >= HOURLY_SWEEP_INTERVAL_MS)
    )
  }

  /** When an hourly run next sweeps; startup, settings, Clean up now and the CLI always do. */
  hourlyDueAt(): number {
    return this.lastSweptAt + HOURLY_SWEEP_INTERVAL_MS
  }

  /** Undefined when not due or when the scan failed: that is not a failed cleanup run, and the next run tries again. */
  async sweepIfDue(
    trigger: WorkspaceCleanupRunTrigger,
    now: number,
    signal: AbortSignal
  ): Promise<WorkspaceCleanupRun['chatHistory']> {
    if (!this.isDue(trigger, now) || signal.aborted) {
      return undefined
    }
    try {
      const settings = this.store.getSettings()
      const started = performance.now()
      const { transcripts, orcaChats } = await deleteChatHistoryOfDeletedWorkspaces(
        this.store,
        signal
      )
      this.lastSweptAt = now
      reportDeletedChatsSweep({
        trigger,
        orcaChatsOn: settings.deleteOrcaChatsWithWorkspace === true,
        transcriptsOn: settings.deleteAgentTranscriptsWithWorkspace === true,
        orcaChats,
        transcripts,
        elapsedMs: performance.now() - started
      })
      return {
        deleted: transcripts.deleted + orcaChats.deleted,
        failed: transcripts.failed + orcaChats.failed,
        freedBytes: transcripts.freedBytes + orcaChats.freedBytes
      }
    } catch (error) {
      console.warn('[workspace-cleanup] Chat history sweep failed', error)
      return undefined
    }
  }
}
