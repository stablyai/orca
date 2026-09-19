import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import type { ResourceEvidence } from '../../shared/resource-evidence-types'

/**
 * One concise line per provider plus one per window, for `orca resource status`
 * without `--json`. Each window names its `scope` so `weekly` and `fableWeekly`
 * stay distinct. Machine consumers should use `--json`.
 */
function formatResourceEvidence(evidence: ResourceEvidence): string {
  const providerNames = Object.keys(evidence.providers) as (keyof ResourceEvidence['providers'])[]
  const lines = [`Resource evidence (queried ${evidence.queriedAt}):`]
  if (providerNames.length === 0) {
    lines.push('  (no provider usage data)')
    return lines.join('\n')
  }
  for (const name of providerNames) {
    const provider = evidence.providers[name]
    if (!provider) continue
    const age = provider.dataAgeMs === null ? 'age unknown' : `${Math.round(provider.dataAgeMs / 1000)}s old`
    const state = provider.available ? 'available' : provider.status
    lines.push(`  ${name}: ${state}${provider.rateLimited ? ' (rate-limited)' : ''} — ${age}`)
    for (const window of provider.windows) {
      const scope = window.pool ? `${window.scope} ${window.pool}` : window.scope
      const label = `${scope} [${window.role}, ${window.windowMinutes}m]`
      const remaining = `~${Math.round(window.remainingRatio * 100)}% left`
      lines.push(`    ${label}: ${remaining}${window.resetAt ? `, resets ${window.resetAt}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** CLI handler for `orca resource status [--json] [--refresh]`. Read-only. */
export const RESOURCE_HANDLERS: Record<string, CommandHandler> = {
  'resource status': async ({ client, json, flags }) => {
    const result = await client.call<ResourceEvidence>('resource.status', {
      refresh: flags.get('refresh') === true
    })
    printResult(result, json, formatResourceEvidence)
  }
}
