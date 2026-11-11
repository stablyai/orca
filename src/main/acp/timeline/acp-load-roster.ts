import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialectNotification } from '../acp-dialects/acp-dialect'
import type { AcpSubagents } from './acp-subagents'

type Roster = NonNullable<Extract<AcpDialectNotification, { disposition: 'map' }>['subagentRoster']>

/** The load window: history is replayed, and the latest `_omp/subagents` roster is held until it ends. */
export class AcpLoadWindow {
  private active = false
  private deferred?: { roster: Roster; at: number }

  constructor(
    private readonly subagents: AcpSubagents,
    private readonly hasOpenPrompt: () => boolean
  ) {}

  get loading(): boolean {
    return this.active
  }

  begin(): void {
    if (this.hasOpenPrompt() || this.active) {
      throw new Error('ACP load overlaps a prompt or load')
    }
    this.active = true
  }

  assertPromptAllowed(): void {
    if (this.active) {
      throw new Error('ACP prompt overlaps a prompt or load')
    }
  }

  /** The roster held during the window is the live state now. */
  finish(join: ProviderTimelineJoin): ProviderTimelineEvent[] {
    this.active = false
    const deferred = this.deferred
    this.deferred = undefined
    return deferred ? this.subagents.translateRoster(deferred.roster, join, deferred.at) : []
  }

  defer(roster: Roster | undefined, at: number): boolean {
    if (!this.active || !roster) {
      return false
    }
    if (this.deferred && roster.seq <= this.deferred.roster.seq) {
      return true
    }
    this.deferred = { roster, at }
    return true
  }

  dispose(): void {
    this.deferred = undefined
  }
}
