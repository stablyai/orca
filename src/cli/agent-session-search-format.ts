import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../shared/ansi-escape-sequences'
import type { AiVaultSearchIndexStatus } from '../shared/ai-vault-search-settings'
import { aiVaultAgentLabel } from '../shared/ai-vault-types'
import { aiVaultSearchUnindexedProviders } from '../shared/ai-vault-search-coverage'
import { getRuntimePathBasename } from '../shared/cross-platform-path'
import type { AiVaultSearchHit, AiVaultSearchResult } from '../shared/ai-vault-search-types'

const ROLE_LABEL: Record<AiVaultSearchHit['evidence']['role'], string> = {
  user: 'you ',
  assistant: 'agent',
  tool: 'tool ',
  system: 'sys  ',
  unknown: '     '
}

function relativeAge(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return 'unknown time'
  }
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) {
    return 'just now'
  }
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return `${Math.max(1, minutes)} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 48) {
    return `${hours} h ago`
  }
  const days = Math.round(hours / 24)
  if (days < 14) {
    return `${days} d ago`
  }
  const weeks = Math.round(days / 7)
  return weeks < 9 ? `${weeks} wk ago` : `${Math.round(days / 30)} mo ago`
}

function projectLabel(hit: AiVaultSearchHit): string {
  // Why: the path comes from the execution host, so node:path would read a
  // Windows path with POSIX rules (and the reverse) when the two disagree.
  const cwd = (hit.cwd ? getRuntimePathBasename(hit.cwd) : '') || '—'
  return hit.branch ? `${cwd} · ${hit.branch}` : cwd
}

// Why: transcript text reaches the terminal verbatim; an OSC 52 or cursor
// sequence inside a tool log would otherwise execute on the user's terminal.
export function terminalSafe(value: string): string {
  return stripAnsiEscapeSequences(value).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
}

function formatHit(index: number, hit: AiVaultSearchHit, owner?: string): string {
  const header = `${String(index + 1).padStart(2)}. ${terminalSafe(hit.title)}`
  const meta = `${aiVaultAgentLabel(hit.agent)} · ${terminalSafe(projectLabel(hit))} · ${relativeAge(hit.updatedAt)}`
  const evidence = hit.evidence.snippet
    ? `    ${ROLE_LABEL[hit.evidence.role]} ▸ ${terminalSafe(hit.evidence.snippet).replaceAll('\n', ' ')}`
    : null
  const resume = `    ${owner ? `run on ${terminalSafe(owner)}` : 'resume'}: ${terminalSafe(hit.resumeCommand)}${hit.cwd ? `  (cwd ${terminalSafe(hit.cwd)})` : ''}`
  return [`${header}    ${meta}`, evidence, resume].filter(Boolean).join('\n')
}

export function formatAgentSessionSearch(
  result: AiVaultSearchResult,
  context: { query: string; cwd: string; owner?: string }
): string {
  const lines: string[] = []
  if (result.sourceUnavailableFiles) {
    lines.push(
      `${result.sourceUnavailableFiles} source files could not be verified; their hits are included but may not resume.`
    )
  }
  if (result.omittedHits) {
    lines.push(`${result.omittedHits} hits omitted by the response limit.`)
  }
  if (result.truncatedSnippets) {
    lines.push(`${result.truncatedSnippets} snippets shortened.`)
  }
  if (result.hits.length === 0) {
    lines.push(`No sessions match "${terminalSafe(context.query)}".`)
  } else {
    lines.push(...result.hits.map((hit, index) => formatHit(index, hit, context.owner)), '')
  }
  if (result.repairedTerms) {
    lines.push(`Searched for: ${terminalSafe(result.repairedTerms.join(' '))}`)
  }
  const { coverage } = result
  const scope = `${coverage.sessionsIndexed.toLocaleString()} sessions indexed`
  const pending =
    coverage.backfill !== 'complete'
      ? ', still indexing older sessions'
      : coverage.filesPending > 0
        ? `, ${coverage.filesPending} changed files pending`
        : ''
  const unindexed = aiVaultSearchUnindexedProviders(coverage)
    .map(
      (provider) =>
        `; ${aiVaultAgentLabel(provider.agent)} not indexed (${(provider.filesDiscovered ?? 0).toLocaleString()} files)`
    )
    .join('')
  lines.push(`${scope}${pending} · ${result.durationMs.toFixed(0)} ms${unindexed}`)
  return lines.join('\n')
}

export function formatAgentSessionSearchEnabled(status: AiVaultSearchIndexStatus): string {
  const scope =
    status.historyDays === null
      ? 'all history'
      : `the last ${status.historyDays.toLocaleString()} days`
  return [
    `Session search is on for ${scope}.`,
    status.paused
      ? 'Indexing is paused; existing data remains searchable.'
      : 'Indexing runs in the background; searches answer from what is covered so far.',
    `Index size: ${status.indexSizeBytes === null ? 'no index file' : `${status.indexSizeBytes} bytes`}.`
  ].join('\n')
}

/** Hosts send reasons with and without their own full stop; never print two. */
function sentence(reason: string): string {
  const text = terminalSafe(reason).trimEnd()
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export function formatAgentSessionSearchStatus(status: AiVaultSearchIndexStatus): string {
  if (status.available === false) {
    return `Session search is unavailable: ${sentence(status.reason ?? 'the service is not installed or initialized')} Saved policy: ${status.enabled ? 'on' : 'off'}.`
  }
  const policy = status.enabled
    ? formatAgentSessionSearchEnabled(status)
    : `Session search is off. Retention: ${status.historyDays === null ? 'all history' : `${status.historyDays} days`}. Index size: ${status.indexSizeBytes ?? 0} bytes.`
  // Why a caveat and not a verdict: the policy above is the saved one and it is
  // real; `applied` only says the host has not finished pushing it to the index.
  return status.applied === false
    ? `${policy}\nSaved policy is not applied yet: ${sentence(status.reason ?? 'the apply is still pending')}`
    : policy
}
