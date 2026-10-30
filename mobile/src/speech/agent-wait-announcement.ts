import { isAskUserQuestionTool } from '../../../src/shared/agent-question-answered-intent'
import { mainAgentState } from '../../../src/shared/main-agent-status'
import {
  ANNOUNCE_WAITS_KEY,
  DEFAULT_ANNOUNCE_WAITS,
  type AnnounceWaits
} from '../storage/speech-preferences'
import type { SpokenAgentRow } from './auto-read-agent-rows'
import { readerLanguage, readerWords } from './reader-words'
import { createStoredChoice } from './stored-choice'

export const useAnnounceWaits = createStoredChoice<AnnounceWaits>(
  ANNOUNCE_WAITS_KEY,
  ['on', 'off'],
  DEFAULT_ANNOUNCE_WAITS
)

export type WaitKind = 'question' | 'permission' | 'other'

/** Pane → when its current wait began, or null while it is not waiting. */
export type WaitBaseline = ReadonlyMap<string, number | null>

export type NewWait = { paneKey: string; since: number; kind: WaitKind }

// Claude's PermissionRequest, Elicitation and AskUserQuestion all end in `waiting`; `blocked`
// comes from terminal status reports and structured sessions that need attention.
function waitKind(agent: SpokenAgentRow, state: string): WaitKind {
  if (isAskUserQuestionTool(agent.toolName ?? undefined)) {
    return 'question'
  }
  return state === 'waiting' && agent.toolName ? 'permission' : 'other'
}

// Why: a first-seen pane only records its state, so enabling auto-read never announces an old wait;
// the main agent's state also carries a subagent's wait, so subagent rows are skipped.
export function findNewWaits(
  baseline: WaitBaseline,
  agents: readonly SpokenAgentRow[]
): { baseline: WaitBaseline; newWaits: NewWait[] } {
  const next = new Map(baseline)
  const newWaits: NewWait[] = []
  for (const agent of agents) {
    if (agent.parentPaneKey) {
      continue
    }
    const state = mainAgentState(agent)
    const waiting = state === 'waiting' || state === 'blocked'
    const since = waiting ? (agent.mainAgent?.stateStartedAt ?? agent.stateStartedAt) : null
    const seen = next.get(agent.paneKey)
    next.set(agent.paneKey, since)
    if (seen !== undefined && since !== null && since !== seen) {
      newWaits.push({ paneKey: agent.paneKey, since, kind: waitKind(agent, state) })
    }
  }
  return { baseline: next, newWaits }
}

export function waitAnnouncement(kind: WaitKind, language = readerLanguage()): string {
  const words = readerWords(language)
  switch (kind) {
    case 'question':
      return words.waitQuestion
    case 'permission':
      return words.waitPermission
    case 'other':
      return words.waitOther
  }
}
