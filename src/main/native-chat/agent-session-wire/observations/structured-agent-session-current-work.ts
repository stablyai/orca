import type {
  StructuredAgentSessionWorkEvidence,
  StructuredAgentSessionCurrentWorkJournal,
  StructuredAgentSessionSeenEnd,
  StructuredAgentSessionReplacedEnd
} from './structured-agent-session-work-evidence'
import {
  reusePromptProjection,
  type PromptProjection
} from './structured-agent-session-actionable-prompts'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { compareAgentJournalItems } from '../../../../shared/agent-session/journal/agent-session-journal-position'
import { currentRequestsProjection } from './agent-session-current-requests'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from '../delivery/structured-agent-session-handing-over'
import {
  StructuredAgentSessionWorkPolicy,
  structuredAgentSessionLiveFence,
  structuredAgentSessionOwnerUnverifiable
} from './structured-agent-session-work-policy'
export {
  structuredAgentSessionLiveFence,
  structuredAgentSessionReplacedRuntimeEnded
} from './structured-agent-session-work-policy'

const promptProjections = new WeakMap<StructuredAgentSessionCurrentWorkJournal, PromptProjection>()

/** Re-read lease evidence per decision; immutable prompts share cursor/fence caches. */
export class StructuredAgentSessionCurrentWork extends StructuredAgentSessionWorkPolicy {
  constructor(
    private readonly journal: StructuredAgentSessionCurrentWorkJournal,
    liveFence: number | null,
    revision = 0,
    ended?: StructuredAgentSessionSeenEnd,
    replaced?: StructuredAgentSessionReplacedEnd,
    ownerUnverifiable = false,
    heldSends?: () => ReadonlySet<string> | undefined
  ) {
    super(
      {
        item: (id) => journal.item(id),
        itemFence: (id) => journal.itemFence(id),
        wroteBeforeOpen: (sequence) => journal.wroteBeforeOpen(sequence),
        runningTurn: () => journal.runningTurn(),
        recoverableSubmissions: () => journal.inputOrder.recoverableSubmissions(),
        continuingInput: (id) => continuingStructuredAgentSessionInput(journal, id),
        finalizingInput: (id) => finalizingStructuredAgentSessionInput(journal, id),
        handingOver: (id) => structuredAgentSessionHandingOver(journal).has(id)
      },
      liveFence,
      revision,
      ended,
      replaced,
      ownerUnverifiable,
      heldSends
    )
  }

  actionablePrompts(): AgentJournalRenderItem[] {
    const cursor = this.journal.cursor()
    const prior = promptProjections.get(this.journal)
    const reusable = reusePromptProjection(this.journal, prior, cursor, this.liveFence)
    if (reusable) {
      return reusable
    }
    const dependencies = new Set<string>()
    const items: AgentJournalRenderItem[] = []
    this.journal.visitItems((itemId, _sequence, body) => {
      if (
        (body.kind === 'approval' || body.kind === 'question') &&
        body.resolution.state === 'pending'
      ) {
        const item = this.journal.item(itemId)
        dependencies.add(itemId)
        if (item?.turnScope?.kind === 'turn') {
          dependencies.add(item.turnScope.turnItemId)
          const turn = readAgentJournalTurn(this.journal.item(item.turnScope.turnItemId)?.body)
          if (turn?.userItemId) {
            dependencies.add(turn.userItemId)
          }
        }
        if (item && this.isCurrentItem(itemId)) {
          items.push(item)
        }
      }
    })
    items.sort(compareAgentJournalItems)
    const stable =
      prior?.items.length === items.length &&
      items.every((item, index) => item === prior.items[index])
        ? prior.items
        : items
    promptProjections.set(this.journal, {
      ...cursor,
      fence: this.liveFence,
      items: stable,
      dependencies
    })
    return stable
  }

  requestProjection(sessionId: string) {
    return currentRequestsProjection(this.journal, sessionId, this)
  }

  actionablePromptIds(): string[] {
    return this.actionablePrompts().map((item) => item.itemId)
  }

  hasActionablePrompt(): boolean {
    return this.actionablePromptIds().length > 0
  }
}

export function structuredAgentSessionCurrentWork(
  journal: StructuredAgentSessionCurrentWorkJournal,
  evidence: StructuredAgentSessionWorkEvidence
): StructuredAgentSessionCurrentWork {
  return new StructuredAgentSessionCurrentWork(
    journal,
    structuredAgentSessionLiveFence(evidence),
    evidence.revision,
    evidence.ended,
    evidence.replaced,
    structuredAgentSessionOwnerUnverifiable(evidence),
    evidence.child?.heldSends
  )
}

/** Test contexts without host projections treat their fence as live. */
export function contextStructuredAgentSessionCurrentWork(ctx: {
  journal: StructuredAgentSessionCurrentWorkJournal
  fence: number
  currentWork?: () => StructuredAgentSessionCurrentWork | null
}): StructuredAgentSessionCurrentWork {
  return ctx.currentWork?.() ?? new StructuredAgentSessionCurrentWork(ctx.journal, ctx.fence)
}
