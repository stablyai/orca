import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { ClaudeJournalSnapshot } from '../../../claude/subagents/claude-subagent-journaled-identities'

/** How a conversation's owner delivers saved facts and holds reading across a replacement. */
export type StructuredAgentSessionSnapshotRecipient = {
  adopt(snapshot: ClaudeJournalSnapshot): void
  hold(): () => void
}
export type StructuredAgentSessionSnapshotSource = (
  recipient: StructuredAgentSessionSnapshotRecipient
) => { release: () => void; adopted: Promise<void> }

/** One acquisition's saved facts, replaced whole per epoch, and the holds a replacement places. */
export class StructuredAgentSessionSinkSnapshots {
  private readonly liveSources = new Set<{
    read(epoch: string): readonly AgentJournalRenderItem[]
    flush(): void
  }>()

  bindLiveText = (source: {
    read(epoch: string): readonly AgentJournalRenderItem[]
    flush(): void
  }): (() => void) => {
    this.liveSources.add(source)
    return () => {
      this.liveSources.delete(source)
    }
  }
  readLiveText = (epoch: string): readonly AgentJournalRenderItem[] =>
    this.held || this.closed ? [] : [...this.liveSources].flatMap((source) => source.read(epoch))
  flushLiveText = (): void => {
    this.liveSources.forEach((source) => source.flush())
  }

  private snapshot: ClaudeJournalSnapshot | null = null
  private release: (() => void) | undefined
  private source: object | undefined
  private holds = 0
  private closed = false
  private readonly unheld: (() => void)[] = []

  constructor(private readonly onHeldChange: () => void) {}

  get held(): boolean {
    return this.holds > 0
  }

  current = (): ClaudeJournalSnapshot | null => (this.closed || this.held ? null : this.snapshot)

  /** Resolves when no epoch replacement's saved facts are outstanding. */
  settled = (): Promise<void> =>
    this.holds === 0 ? Promise.resolve() : new Promise((resolve) => this.unheld.push(resolve))

  /** Prebind: resolves once the first snapshot is read; later replacements swap it in order. */
  follow(source: StructuredAgentSessionSnapshotSource): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('agent_session_sink_closed'))
    }
    this.release?.()
    const token = {}
    this.source = token
    this.snapshot = null
    const holds = new Set<() => void>()
    this.onHeldChange()
    const { release, adopted } = source({
      adopt: (snapshot) => {
        if (!this.closed && this.source === token) {
          this.snapshot = snapshot
          this.onHeldChange()
        }
      },
      hold: () => {
        if (this.closed || this.source !== token) {
          return () => {}
        }
        const unhold = this.hold()
        const releaseHold = () => {
          holds.delete(releaseHold)
          unhold()
        }
        holds.add(releaseHold)
        return releaseHold
      }
    })
    this.release = () => {
      if (this.source === token) {
        this.source = undefined
        this.snapshot = null
      }
      release()
      for (const unhold of holds) {
        unhold()
      }
      this.onHeldChange()
    }
    return adopted
  }

  close(): void {
    this.closed = true
    this.snapshot = null
    this.liveSources.clear()
    this.release?.()
    this.release = undefined
    this.resolveUnheld()
  }

  private hold(): () => void {
    this.holds += 1
    this.onHeldChange()
    let held = true
    return () => {
      if (!held) {
        return
      }
      held = false
      this.holds -= 1
      this.onHeldChange()
      if (this.holds === 0) {
        this.resolveUnheld()
      }
    }
  }

  private resolveUnheld(): void {
    for (const resolve of this.unheld.splice(0)) {
      resolve()
    }
  }
}
