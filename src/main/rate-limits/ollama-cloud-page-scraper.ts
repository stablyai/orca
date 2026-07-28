// Why: the ollama.com/settings page renders usage data as plain HTML with
// "X% used" text. We find the percentage values and disambiguate session vs
// weekly by scanning the surrounding text for context keywords.

type ParsedOllamaCloudUsage = {
  sessionPercent: number
  weeklyPercent: number
  sessionResetInSec: number | null
  weeklyResetInSec: number | null
}

/**
 * Parses ollama.com/settings HTML for usage percentage data.
 * Looks for "X% used" patterns and disambiguates session vs weekly by
 * scanning the preceding text for context keywords.
 */
export function parseOllamaCloudFromPageText(text: string): ParsedOllamaCloudUsage | null {
  if (!text || text.length > 10_000_000) {
    return null
  }

  const usageRe = /(\d+(?:\.\d+)?)%\s*used/gi
  const usageMatches = [...text.matchAll(usageRe)]

  if (usageMatches.length === 0) {
    return null
  }

  let sessionPct: number | undefined
  let weeklyPct: number | undefined

  for (const match of usageMatches) {
    const pct = Number.parseFloat(match[1])
    if (!Number.isFinite(pct)) continue

    const pos = match.index!
    const context = text.slice(Math.max(0, pos - 500), pos).toLowerCase()

    if (context.includes('session')) {
      sessionPct = pct
    } else if (context.includes('weekly')) {
      weeklyPct = pct
    }
  }

  // Fallback to positional if context matching failed
  if (sessionPct === undefined || weeklyPct === undefined) {
    const uniquePcts = [
      ...new Set(
        usageMatches
          .map((m) => Number.parseFloat(m[1]))
          .filter((n) => !Number.isNaN(n))
      )
    ]
    if (sessionPct === undefined) sessionPct = uniquePcts[0] ?? 0
    if (weeklyPct === undefined) weeklyPct = uniquePcts[1] ?? uniquePcts[0] ?? 0
  }

  // Parse reset times from data-time attributes on local-time elements
  const timeRe = /class="[^"]*local-time[^"]*"[^>]*data-time="([^"]*)"/g
  const resetTimes = [...text.matchAll(timeRe)].map((m) => m[1])

  // Convert ISO reset times to seconds from now
  const sessionResetInSec = resetTimes[0] ? isoToSecondsFromNow(resetTimes[0]) : null
  const weeklyResetInSec = resetTimes[1] ? isoToSecondsFromNow(resetTimes[1]) : null

  return {
    sessionPercent: Math.min(100, Math.max(0, sessionPct)),
    weeklyPercent: Math.min(100, Math.max(0, weeklyPct)),
    sessionResetInSec,
    weeklyResetInSec
  }
}

function isoToSecondsFromNow(iso: string): number | null {
  try {
    const target = new Date(iso).getTime()
    if (Number.isNaN(target)) return null
    const diff = Math.max(0, target - Date.now())
    return Math.round(diff / 1000)
  } catch {
    return null
  }
}
