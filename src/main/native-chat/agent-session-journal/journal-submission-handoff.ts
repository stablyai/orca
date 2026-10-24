import type { JournalReducerState } from './journal-reducer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'

function replaceIndex(
  index: Map<string, Set<string>>,
  id: string,
  before?: string | null,
  after?: string | null
) {
  if (before === after) {
    return
  }
  if (before) {
    const members = index.get(before)
    members?.delete(id)
    if (!members?.size) {
      index.delete(before)
    }
  }
  if (after) {
    index.set(after, (index.get(after) ?? new Set<string>()).add(id))
  }
}

/** Derived while folding existing rows; output/status edges never scan the journal's history. */
export class JournalMailHandoffs {
  private readonly providers = new Map<string, Set<string>>()
  private readonly queued = new Map<string, Set<string>>()
  private readonly identities = new Map<string, { provider?: string | null; queued?: string }>()
  private readonly openers = new Map<string, Set<string>>()
  personSequence = 0

  submission(id: string, next?: AgentJournalSubmission): void {
    const before = this.identities.get(id)
    replaceIndex(this.providers, id, before?.provider, next?.providerItemId)
    replaceIndex(this.queued, id, before?.queued, next?.queuedMessageId)
    if (next) {
      this.identities.set(id, { provider: next.providerItemId, queued: next.queuedMessageId })
    } else {
      this.identities.delete(id)
    }
    if (
      next?.dispatchState === 'accepted' &&
      next.origin === 'client' &&
      next.source?.kind !== 'agent'
    ) {
      this.personSequence = Math.max(this.personSequence, next.submittedSequence ?? 0)
    }
  }

  item(id: string, before?: AgentJournalRenderItem, after?: AgentJournalRenderItem): void {
    const opener = (item?: AgentJournalRenderItem) =>
      item && isRootAgentJournalItem(item) ? readAgentJournalTurn(item.body)?.userItemId : undefined
    replaceIndex(this.openers, id, opener(before), opener(after))
  }

  queuedSubmission(id: string): string | undefined {
    const matches = this.queued.get(id)
    return matches?.size === 1 ? matches.values().next().value : undefined
  }

  owner(state: JournalReducerState, clientMessageId: string) {
    const submission = state.submissions.get(clientMessageId)
    if (!submission) {
      return null
    }
    const exact = this.openers.get(agentJournalSubmissionKey(clientMessageId))
    if (exact && exact.size > 1) {
      return null
    }
    const matches = new Set(exact)
    const provider = submission.providerItemId
    if (provider && this.providers.get(provider)?.size === 1) {
      const aliases = this.openers.get(provider)
      if (aliases && aliases.size > 1) {
        return null
      }
      for (const id of aliases ?? []) {
        matches.add(id)
      }
    }
    const scope = state.submissionTurnScopes.get(clientMessageId)
    if (scope?.kind === 'turn') {
      matches.add(scope.turnItemId)
    }
    const owners = [...matches].flatMap((itemId) => {
      const item = state.items.get(itemId)
      const turn = item && isRootAgentJournalItem(item) ? readAgentJournalTurn(item.body) : null
      return turn ? [{ itemId, turn }] : []
    })
    return owners.length === 1 ? owners[0] : null
  }
}
