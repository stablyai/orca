import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isStructuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-entry'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Index only the current request window; the canonical cut reader still decides recovery. */
export class StructuredAccountRecovery {
  private readonly groups = new Map<string, Map<string, AgentJournalRenderItem>>()
  private readonly pending = new Map<string, AgentJournalSubmission>()
  private requests: AgentJournalRenderItem[] = []
  private latest: AgentJournalRenderItem | null = null
  private building = true
  private floor = 0

  reset(): void {
    this.groups.clear()
    this.pending.clear()
    this.requests = []
    this.latest = null
    this.building = true
    this.floor = 0
  }

  ready(): void {
    this.building = false
    for (const key of this.groups.keys()) {
      if (key !== this.latest?.itemId) {
        this.groups.delete(key)
      }
    }
  }

  submission(submission: AgentJournalSubmission | undefined): void {
    if (!submission) {
      return
    }
    if (submission.dispatchState === 'pending') {
      this.pending.set(submission.clientMessageId, submission)
    } else {
      this.pending.delete(submission.clientMessageId)
    }
  }

  item(journal: AgentSessionJournal, item: AgentJournalRenderItem): void {
    if (!isRootAgentJournalItem(item)) {
      return
    }
    if (isAgentSessionContextClear(item.body)) {
      if (item.sequence > this.floor) {
        this.floor = item.sequence
        this.groups.clear()
        this.requests = []
        this.latest = null
      }
      return
    }
    if (item.sequence <= this.floor) {
      return
    }
    const turn = readAgentJournalTurn(item.body)
    if (turn && !isStructuredAgentSessionCommandTurn(turn, journal.itemBody)) {
      if (item.sequence >= (this.latest?.sequence ?? 0)) {
        if (!this.building && this.latest?.itemId !== item.itemId) {
          this.groups.clear()
        }
        this.latest = item
      }
    }
    const scope = turn
      ? item.itemId
      : item.turnScope?.kind === 'turn'
        ? item.turnScope.turnItemId
        : null
    if (scope && (this.building || scope === this.latest?.itemId)) {
      const group = this.groups.get(scope) ?? new Map<string, AgentJournalRenderItem>()
      group.set(item.itemId, item)
      this.groups.set(scope, group)
    }
    if (item.body.kind === 'message' && item.body.role === 'user') {
      this.requests = this.requests.filter((entry) => entry.itemId !== item.itemId)
    }
    if (
      item.body.kind === 'message' &&
      item.body.role === 'user' &&
      !item.body.command &&
      item.turnScope?.kind !== 'turn'
    ) {
      this.requests = [...this.requests.filter((entry) => entry.itemId !== item.itemId), item]
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 2)
    }
  }

  allows(journal: AgentSessionJournal, next: AgentJournalSubmission): boolean {
    const key = journal.canonicalItemId(agentJournalSubmissionKey(next.clientMessageId))
    const items = [
      ...(this.groups.get(this.latest?.itemId ?? '')?.values() ?? []),
      ...this.requests.filter((item) => item.itemId !== key)
    ].sort((a, b) => a.sequence - b.sequence)
    return (
      latestNativeChatUsageLimitCut(
        items,
        [...this.pending.values()].filter(
          (submission) => submission.clientMessageId !== next.clientMessageId
        )
      ) !== null
    )
  }
}
