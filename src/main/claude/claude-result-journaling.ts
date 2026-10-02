// Journaling ONE Claude `result` frame: the end of the root turn it settles, and the diagnostic
// row a failed or unrecognised result leaves.
//
// Split out of the translator when that file reached its line budget; the translator still owns
// the open turn and every collaborator this writes through.

import type { ClaudeContextFacts } from './claude-context-facts'
import { claudeCommandResultEnd } from './claude-command-turn'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import type { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { claudeFrameParentRef, isRootClaudeFrame } from './claude-turn-opening'

export type ClaudeResultJournalContext = Pick<
  ClaudeMessageJournalContext,
  | 'sink'
  | 'streamedBlocks'
  | 'streamedText'
  | 'subagents'
  | 'providerFallback'
  | 'corrections'
  | 'turn'
> & {
  prompts: ClaudeJournalPrompts
  context: ClaudeContextFacts
}

export function journalClaudeResult(
  {
    sink,
    streamedBlocks,
    streamedText,
    subagents,
    providerFallback,
    corrections,
    turn,
    prompts,
    context
  }: ClaudeResultJournalContext,
  message: Record<string, unknown>,
  observedAt: number
): void {
  // Every turn this translator opens is root by construction, so a nested
  // result settles the child that produced it and never the turn. The
  // diagnostic below still runs: a child's failure is reportable even when
  // it ends no turn.
  const settlesTurn = isRootClaudeFrame(message)
  const commandEnd = settlesTurn ? claudeCommandResultEnd(turn, sink, message, observedAt) : null
  if (commandEnd === 'another-input') {
    return
  }
  // Read before the settle below closes it: the result reports that turn's end.
  const endedTurnScope = turn.turnScope
  // Read before the settle below closes the turn: an error end the journal's Stop rule makes a
  // person's cancellation is theirs to decide as the end is written (`turnEndAfterStop`).
  const turnId = settlesTurn ? turn.id : null
  const leftToStop =
    turnId !== null &&
    sink.journalStopDecidesTurn?.(turnId, observedAt, turn.openedBy ?? undefined) === true
  if (settlesTurn) {
    prompts.retryPendingCancellations()
    turn.suppressReopenOnFailure(message.is_error === true)
    // The turn is over however it ended, so a foreground child still
    // reported as working will never be settled by an event.
    subagents.settleTurn(turn.groupKey)
    context.settle(message, commandEnd ?? claudeTurnEndForResult(message, observedAt, leftToStop))
    // The turn is over. A block still awaiting its final keeps the text the
    // flush above journaled, but its live state goes: an interrupted turn
    // would otherwise retain that text for the life of the session.
    streamedBlocks.clear()
    streamedText.settle()
  }
  const kind = claudeProviderFrameKind(message)
  const failure = claudeResultFailure(message, leftToStop)
  if (failure || !isSettledClaudeResultKind(kind)) {
    providerFallback.append(
      kind,
      message,
      failure?.text,
      undefined,
      undefined,
      // A result that settles no turn is a CHILD's result: this
      // translator only ever opens root turns.
      settlesTurn
        ? () => ({ turnScope: endedTurnScope })
        : corrections.stampFor(claudeFrameParentRef(message))
    )
  }
}
