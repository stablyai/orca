import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../shared/ansi-escape-sequences'
import { aiVaultAgentLabel } from '../shared/ai-vault-types'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../shared/ai-vault-search-types'

type SessionSearchResults = Extract<AiVaultSearchResponse, { kind: 'results' }>
/** Malformed cursors are a caller mistake and leave through the CLI error channel. */
export type PrintableSessionSearchResponse = Exclude<
  AiVaultSearchResponse,
  { kind: 'malformed-cursor' }
>

/**
 * Transcript text reaches the terminal verbatim, so an OSC 52 or cursor sequence
 * inside a tool log would otherwise run on the reader's terminal. The `[[` `]]`
 * match marks are left as the engine wrote them: this CLI emits no ANSI anywhere,
 * so a colour scheme invented here would be the only one in the surface.
 */
export function terminalSafe(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

function oneLine(value: string): string {
  return terminalSafe(value)
    .replaceAll(/[\r\n]+/g, ' ')
    .trim()
}

function formatHit(hit: AiVaultSearchHit): string {
  const host = oneLine(hit.executionHostId ?? '')
  const header = [
    aiVaultAgentLabel(hit.agent),
    oneLine(hit.updatedAt ?? '') || 'unknown time',
    oneLine(hit.title) || '(untitled)',
    ...(host ? [`host=${host}`] : [])
  ].join('  ')
  const evidence = hit.evidence
    ? `    ${hit.evidence.role}: ${oneLine(hit.evidence.snippet)}`
    : '    no text evidence for this match'
  // Withheld for paired callers by the contract, so its absence is not a failure.
  const resume = hit.resumeCommand ? [`    resume: ${oneLine(hit.resumeCommand)}`] : []
  return [header, evidence, ...resume].join('\n')
}

function formatTruncation(truncated: SessionSearchResults['truncated']): string[] {
  return [
    ...(truncated.candidates
      ? ['ranking saw only the first batch of candidate sessions, so a better match may be missing']
      : []),
    ...(truncated.query ? ['query was cut'] : []),
    ...(truncated.freshness
      ? ['freshness wait timed out; these results come from the index as it stood']
      : []),
    ...(truncated.snippets > 0 ? [`${truncated.snippets} snippets were shortened`] : [])
  ]
}

function formatDebug(debug: SessionSearchResults['debug']): string[] {
  if (!debug) {
    return []
  }
  return [
    '',
    'debug:',
    `  route: ${debug.route}`,
    ...(debug.repairedTerms
      ? [`  repairedTerms: ${debug.repairedTerms.map((term) => oneLine(term)).join(' ')}`]
      : []),
    `  plannerScope: ${debug.plannerReport.scope}`
  ]
}

function formatUnavailable(reason: 'disabled' | 'not-ready' | 'no-service'): string {
  if (reason === 'disabled') {
    return 'Session search is off on this host.'
  }
  if (reason === 'not-ready') {
    return 'Session search is not ready on this host yet. Try again once its index has started.'
  }
  return [
    'This host runs no session search service.',
    'An Orca host older than session search answers the same way; update it and try again.'
  ].join('\n')
}

function formatResults(response: SessionSearchResults): string {
  const body =
    response.hits.length === 0 ? ['No sessions match this query.'] : response.hits.map(formatHit)
  const cursor = oneLine(response.page.cursor ?? '')
  const footer = [
    `${response.hits.length} ${response.hits.length === 1 ? 'result' : 'results'} on this page, ${Math.round(response.durationMs)} ms.`,
    ...(response.page.hasMore && cursor
      ? [`more pages: re-run with --cursor ${cursor}`]
      : response.page.hasMore
        ? ['more pages exist, but this host issued no cursor for them']
        : []),
    ...formatTruncation(response.truncated)
  ]
  return [...body, '', ...footer, ...formatDebug(response.debug)].join('\n')
}

export function formatSessionSearchResponse(response: PrintableSessionSearchResponse): string {
  if (response.kind === 'unavailable') {
    return formatUnavailable(response.reason)
  }
  if (response.kind === 'stale-cursor') {
    return [
      'The index moved on since that page, so the cursor no longer names a place in it.',
      'Re-run the same search without --cursor to start again from page 1.'
    ].join('\n')
  }
  return formatResults(response)
}

function formatEpochMs(value: number | null): string {
  return value === null ? 'never' : new Date(value).toISOString()
}

export function formatSessionSearchStatus(status: AiVaultSearchStatus): string {
  return [
    `enabled: ${status.enabled}`,
    `phase: ${status.phase}`,
    `filesIndexed: ${status.filesIndexed}`,
    `filesDue: ${status.filesDue}`,
    `filesFailed: ${status.filesFailed}`,
    `lastReconcileAt: ${formatEpochMs(status.lastReconcileAt)}`,
    `lastSweepCompletedAt: ${formatEpochMs(status.lastSweepCompletedAt)}`,
    `generation: ${status.generation}`,
    `degradedRoots: ${status.degradedRoots.length}`,
    // A paired host withholds the root itself and sends the count with a fixed reason.
    ...status.degradedRoots.map(
      (root) => `  ${root.root ? oneLine(root.root) : '(withheld)'}: ${oneLine(root.reason)}`
    )
  ].join('\n')
}
