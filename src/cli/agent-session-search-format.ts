import { basename } from 'node:path'
import { aiVaultAgentLabel } from '../shared/ai-vault-types'
import { aiVaultSearchUnindexedProviders } from '../shared/ai-vault-search-coverage'
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
  const cwd = hit.cwd ? basename(hit.cwd) : '—'
  return hit.branch ? `${cwd} · ${hit.branch}` : cwd
}

function formatHit(index: number, hit: AiVaultSearchHit): string {
  const header = `${String(index + 1).padStart(2)}. ${hit.title}`
  const meta = `${aiVaultAgentLabel(hit.agent)} · ${projectLabel(hit)} · ${relativeAge(hit.updatedAt)}`
  const evidence = hit.evidence.snippet
    ? `    ${ROLE_LABEL[hit.evidence.role]} ▸ ${hit.evidence.snippet.replaceAll('\n', ' ')}`
    : null
  const resume = `    resume: ${hit.resumeCommand}${hit.cwd ? `  (cwd ${hit.cwd})` : ''}`
  return [`${header}    ${meta}`, evidence, resume].filter(Boolean).join('\n')
}

export function formatAgentSessionSearch(
  result: AiVaultSearchResult,
  context: { query: string; cwd: string }
): string {
  const lines: string[] = []
  if (result.hits.length === 0) {
    lines.push(`No sessions match "${context.query}".`)
  } else {
    lines.push(...result.hits.map((hit, index) => formatHit(index, hit)), '')
  }
  if (result.repairedTerms) {
    lines.push(`Searched for: ${result.repairedTerms.join(' ')}`)
  }
  const { coverage } = result
  const scope = `${coverage.sessionsIndexed.toLocaleString()} sessions indexed`
  const pending =
    coverage.backfill === 'running'
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
