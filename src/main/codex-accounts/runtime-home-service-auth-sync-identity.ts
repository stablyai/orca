import { codexAuthIsFresher } from './codex-auth-identity'

function readCodexLastRefresh(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const value = (parsed as Record<string, unknown>).last_refresh
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value !== 'string' || !value.trim()) {
      return null
    }
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
  } catch {
    return null
  }
}

export function codexAuthIsMonotonicallyFresher(
  candidateAuthJson: string,
  baselineAuthJson: string
): boolean {
  const candidateLastRefresh = readCodexLastRefresh(candidateAuthJson)
  const baselineLastRefresh = readCodexLastRefresh(baselineAuthJson)
  if (candidateLastRefresh !== null || baselineLastRefresh !== null) {
    return (
      candidateLastRefresh !== null &&
      baselineLastRefresh !== null &&
      candidateLastRefresh > baselineLastRefresh
    )
  }
  return codexAuthIsFresher(candidateAuthJson, baselineAuthJson)
}
