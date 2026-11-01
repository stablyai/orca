import { CodexJournalCompactions } from './codex-structured-journal-compactions'
import type { CodexJournalTranslatorDeps } from './codex-structured-journal-contracts'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { CodexJournalItems } from './codex-structured-journal-items'
import { CodexJournalPrompts } from './codex-structured-journal-prompts'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { CodexJournalTurnScopes } from './codex-journal-turn-scopes'
import { CodexJournalCommandTurn } from './codex-journal-command-turn'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { CodexSubagentLinkage, type CodexRowAttribution } from './codex-subagent-linkage'

export function createCodexJournalTranslatorWriters(deps: CodexJournalTranslatorDeps) {
  const activeTurns = new CodexJournalActiveTurns()
  const activeTurn = (threadId: string): string | null => activeTurns.current(threadId)
  const primaryThreadId = (): string | null => deps.primaryThreadId?.() ?? null
  const commands = new CodexJournalCommandTurn()
  const turnScopes = new CodexJournalTurnScopes({
    sessionId: deps.sessionId,
    primaryThreadId,
    activeTurn,
    commandScope: (turnId) => commands.scopeFor(turnId)
  })
  // Translator and background tracker can feed the same frame; execution updates are idempotent.
  const executions = deps.subagentExecutions ?? new CodexSubagentExecutions()
  const { linkageFor } = new CodexSubagentLinkage({ primaryThreadId, executions })
  const attributionFor: CodexRowAttribution = (threadId, turnId) => ({
    ...linkageFor(threadId, turnId),
    turnScope: turnScopes.scopeFor(threadId, turnId)
  })
  const producerDeps = { ...deps, attributionFor }
  const genericFrames = new CodexJournalGenericFrames(producerDeps, activeTurn)
  const items = new CodexJournalItems(
    producerDeps,
    activeTurn,
    (threadId, turnId) => genericFrames.suppress(threadId, turnId),
    (threadId) => executions.label(threadId)
  )
  return {
    activeTurns,
    commands,
    executions,
    attributionFor,
    genericFrames,
    items,
    compactions: new CodexJournalCompactions(deps.sink, activeTurn, attributionFor, (turnId) =>
      commands.compacted(turnId)
    ),
    goals: new CodexJournalGoals(deps.sink, attributionFor),
    prompts: new CodexJournalPrompts(
      producerDeps,
      (threadId, itemId) => items.detailFor(threadId, itemId),
      activeTurn
    )
  }
}
