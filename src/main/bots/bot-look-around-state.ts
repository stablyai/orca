// What a bot's looks found, and what the owner did with it. Pure: the store persists it.
import type { BotTidyUpState } from './bot-memory-tidy-up'
import { botRunFailure } from './bot-run-failure-code'
import { randomUUID } from 'node:crypto'
import { containsSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import type { Bot } from '../../shared/bot-types'
import {
  botLookAround,
  lookAroundSupported,
  SUGGESTION_LIMITS,
  type BotUpNext,
  suggestionSource,
  suggestionKey,
  linkCarriesCredential,
  type Suggestion,
  type UpNextState
} from '../../shared/bots/bot-look-around'

const DAY_MS = 24 * 60 * 60 * 1000
/** A dismissed title is refused this long. */
export const DISMISSED_FOR_MS = 30 * DAY_MS
/** An open suggestion this old is dropped even when looks keep failing. */
export const OPEN_FOR_MS = 3 * DAY_MS
/** Started titles a look is told about, so it learns what the owner acts on. */
export const STARTED_RECALL_MS = 14 * DAY_MS
const MAX_SUGGESTIONS = 200
const MAX_RUNS = 50

export type SuggestionStatus = 'open' | 'started' | 'dismissed' | 'replaced'

export type StoredSuggestion = Suggestion & {
  /** The look that made it, or last suggested it again. */
  runSessionId: string
  status: SuggestionStatus
  resolvedAt?: number
}

export {
  ASLEEP_RETRY_AFTER_MS,
  backgroundRunSessionIds,
  lastRunStartedAt,
  slotTaken,
  withBackgroundRun,
  withoutBackgroundRun,
  type BackgroundRuns,
  type LookAroundRun
} from './bot-background-run-history'
import {
  withBackgroundRun,
  type BackgroundRuns,
  type LookAroundRun,
  type LookUsageLimit
} from './bot-background-run-history'

export type BotLookState = BackgroundRuns & {
  /** When the bot first had a conversation; looks start one interval after it. */
  armedAt?: number
  lastLookNowAt?: number
  suggestions: StoredSuggestion[]
  /** One per dismissed title for its 30 days, kept apart from `suggestions` so their cap never frees one. */
  dismissals: Dismissal[]
  /** When the owner last saw Up next; suggestions made after it count as new. */
  seenAt?: number
  tidyUp?: BotTidyUpState
}

/** `key` is the suggestion's key (see `suggestionKey`); absent in a record from before links keyed it. */
export type Dismissal = { title: string; key?: string; at: number }

function dismissalKey(dismissal: Dismissal): string {
  return dismissal.key ?? suggestionKey({ title: dismissal.title })
}

export const EMPTY_BOT_LOOK: BotLookState = {
  runs: [],
  suggestions: [],
  dismissals: []
}

export type SuggestInput = { title: string; why: string; ask: string; link?: string }

export type SuggestOutcome =
  | { ok: true; suggestion: StoredSuggestion }
  | { ok: false; refusal: string }

export const SUGGEST_REFUSALS = {
  notALook: 'Only a look-around run can suggest next steps.',
  full: `You already suggested ${SUGGESTION_LIMITS.perRun} this time. Stop here.`,
  repeated: 'Already suggested in this run.',
  dismissed: 'They dismissed this recently. Don’t suggest it again, in any wording.',
  secret: 'The request looks like it contains a credential. Leave secrets out of suggestions.'
} as const

function inRun(state: BotLookState, sessionId: string): LookAroundRun | undefined {
  return state.runs.find((run) => run.sessionId === sessionId)
}

/** The newest look, stopped by its usage limit: continuing its session (at the reset, or by the
 *  owner) finishes that look, so it may still suggest. An older one would replace a newer list. */
export function continuable(state: BotLookState, run: LookAroundRun): boolean {
  return run.endedAt !== undefined && run.usageLimited !== undefined && state.runs.at(-1) === run
}

/** Open suggestions past their age become replaced; resolved ones past the dismiss window go. */
export function expired(state: BotLookState, now: number): BotLookState {
  const suggestions = state.suggestions
    .map((entry) =>
      entry.status === 'open' && now - entry.createdAt > OPEN_FOR_MS
        ? { ...entry, status: 'replaced' as const, resolvedAt: now }
        : entry
    )
    .filter(
      (entry) =>
        entry.status === 'open' || now - (entry.resolvedAt ?? entry.createdAt) <= DISMISSED_FOR_MS
    )
    .slice(-MAX_SUGGESTIONS)
  const dismissals = state.dismissals.filter((entry) => now - entry.at <= DISMISSED_FOR_MS)
  return { ...state, suggestions, dismissals }
}

export function beginRun(state: BotLookState, sessionId: string, now: number): BotLookState {
  return withBackgroundRun(state, sessionId, now, MAX_RUNS)
}

/** A finished look replaces the open list with what it suggested; a failed one only adds. */
export function endRun(
  state: BotLookState,
  sessionId: string,
  now: number,
  error?: string,
  alerted = false,
  asleep = false,
  usageLimited?: LookUsageLimit
): BotLookState {
  const failure = error
    ? {
        error,
        ...(alerted ? { alerted: true as const } : {}),
        ...(asleep ? { asleep: true as const } : {}),
        ...(usageLimited && !asleep ? { usageLimited } : {})
      }
    : {}
  const runs = state.runs.map((run) =>
    run.sessionId === sessionId && run.endedAt === undefined
      ? { ...run, endedAt: now, ...failure }
      : run
  )
  const suggestions = error
    ? state.suggestions
    : state.suggestions.map((entry) =>
        entry.status === 'open' && entry.runSessionId !== sessionId
          ? { ...entry, status: 'replaced' as const, resolvedAt: now }
          : entry
      )
  return expired({ ...state, runs, suggestions }, now)
}

export function suggest(
  state: BotLookState,
  sessionId: string,
  input: SuggestInput,
  now: number
): { state: BotLookState; outcome: SuggestOutcome } {
  const refuse = (refusal: string) => ({ state, outcome: { ok: false as const, refusal } })
  const run = inRun(state, sessionId)
  if (!run || (run.endedAt !== undefined && !continuable(state, run))) {
    return refuse(SUGGEST_REFUSALS.notALook)
  }
  const key = suggestionKey(input)
  const thisRun = state.suggestions.filter((entry) => entry.runSessionId === sessionId)
  if (thisRun.some((entry) => suggestionKey(entry) === key)) {
    return refuse(SUGGEST_REFUSALS.repeated)
  }
  if (thisRun.length >= SUGGESTION_LIMITS.perRun) {
    return refuse(SUGGEST_REFUSALS.full)
  }
  if (
    state.dismissals.some(
      (entry) => dismissalKey(entry) === key && now - entry.at <= DISMISSED_FOR_MS
    )
  ) {
    return refuse(SUGGEST_REFUSALS.dismissed)
  }
  if (
    containsSecretLike(`${input.title}\n${input.why}\n${input.ask}`) ||
    (input.link !== undefined && linkCarriesCredential(input.link))
  ) {
    return refuse(SUGGEST_REFUSALS.secret)
  }
  const source = suggestionSource(input.link)
  const fields = {
    title: input.title,
    why: input.why,
    ask: input.ask,
    ...(input.link ? { link: input.link } : {}),
    ...(source ? { source } : {}),
    runSessionId: sessionId
  }
  // Suggested again: it keeps its id and age, so on screen it neither moves nor reads as new.
  const earlier = state.suggestions.find(
    (entry) => entry.status === 'open' && suggestionKey(entry) === key
  )
  const suggestion: StoredSuggestion = earlier
    ? { id: earlier.id, createdAt: earlier.createdAt, status: 'open', ...fields }
    : { id: randomUUID(), createdAt: now, status: 'open', ...fields }
  const suggestions = earlier
    ? state.suggestions.map((entry) => (entry.id === earlier.id ? suggestion : entry))
    : [...state.suggestions, suggestion]
  return { state: { ...state, suggestions }, outcome: { ok: true, suggestion } }
}

export type ResolveOutcome =
  | { ok: true; suggestion: StoredSuggestion }
  | {
      ok: false
      refusal: 'not_found' | 'already_started' | 'already_dismissed' | 'no_longer_listed'
    }

/** Start or Dismiss moves a suggestion out of open exactly once. */
export function resolve(
  state: BotLookState,
  id: string,
  to: 'started' | 'dismissed',
  now: number
): { state: BotLookState; outcome: ResolveOutcome } {
  const entry = state.suggestions.find((candidate) => candidate.id === id)
  if (!entry) {
    return { state, outcome: { ok: false, refusal: 'not_found' } }
  }
  if (entry.status !== 'open') {
    const refusal =
      entry.status === 'started'
        ? 'already_started'
        : entry.status === 'dismissed'
          ? 'already_dismissed'
          : 'no_longer_listed'
    return { state, outcome: { ok: false, refusal } }
  }
  const resolved = { ...entry, status: to, resolvedAt: now }
  const key = suggestionKey(entry)
  const dismissals =
    to === 'dismissed'
      ? [
          ...state.dismissals.filter((dismissal) => dismissalKey(dismissal) !== key),
          { title: entry.title, key, at: now }
        ]
      : state.dismissals
  return {
    state: {
      ...state,
      suggestions: state.suggestions.map((candidate) =>
        candidate.id === id ? resolved : candidate
      ),
      dismissals
    },
    outcome: { ok: true, suggestion: resolved }
  }
}

function visible(entry: StoredSuggestion): Suggestion {
  return {
    id: entry.id,
    title: entry.title,
    why: entry.why,
    ask: entry.ask,
    ...(entry.link ? { link: entry.link } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    createdAt: entry.createdAt
  }
}

export function upNextItems(state: BotLookState, now: number): Suggestion[] {
  return expired(state, now)
    .suggestions.filter((entry) => entry.status === 'open')
    .map(visible)
}

export function upNextState(state: BotLookState, nextAt: number | undefined): UpNextState {
  const current = state.runs.find((run) => run.endedAt === undefined)
  const last = state.runs.toReversed().find((run) => run.endedAt !== undefined)
  return {
    running: current !== undefined,
    ...(current ? { runSessionId: current.sessionId } : {}),
    seenAt: state.seenAt ?? 0,
    ...(last?.endedAt !== undefined
      ? { lastLookedAt: last.endedAt, tookMs: last.endedAt - last.startedAt }
      : {}),
    ...(last ? { lastSessionId: last.sessionId } : {}),
    ...(last?.error ? { error: last.error, failure: botRunFailure(last.error) } : {}),
    ...(nextAt !== undefined ? { nextAt } : {})
  }
}

/** What the next look is told: what is still listed, what the owner started, what they dismissed. */
export function lookHistory(state: BotLookState, now: number) {
  const titles = (status: SuggestionStatus, within: number) =>
    state.suggestions
      .filter(
        (entry) => entry.status === status && now - (entry.resolvedAt ?? entry.createdAt) <= within
      )
      .map((entry) => entry.title)
  return {
    open: titles('open', OPEN_FOR_MS),
    started: titles('started', STARTED_RECALL_MS),
    dismissed: state.dismissals
      .filter((entry) => now - entry.at <= DISMISSED_FOR_MS)
      .map((entry) => entry.title)
  }
}

export function lookAroundOn(bot: Pick<Bot, 'agent' | 'lookAround'>): boolean {
  return botLookAround(bot).on && lookAroundSupported(bot.agent)
}

/** The bot's Up next as clients draw it; undefined while Look around is off or can't run. */
export function lookAroundUpNext(
  store: { get: (botId: string) => BotLookState },
  bot: Pick<Bot, 'id' | 'agent' | 'lookAround'>,
  now: number,
  nextAt?: number,
  /** A slot is owed now and starts once the host is in full wake. */
  dueNow = false
): BotUpNext | undefined {
  if (!lookAroundOn(bot)) {
    return undefined
  }
  const state = store.get(bot.id)
  const upNext = upNextState(state, nextAt)
  return {
    state: dueNow && !upNext.running ? { ...upNext, dueNow: true } : upNext,
    items: upNextItems(state, now)
  }
}
