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

  // Why: ollama.com/settings renders usage as aria-label="Session usage X% used"
  // and aria-label="Weekly usage X% used". Match the full label for reliable
  // disambiguation instead of searching for bare percentages.
  const sessionRe = /aria-label="Session usage\s+(\d+(?:\.\d+)?)%\s*used"/i
  const weeklyRe = /aria-label="Weekly usage\s+(\d+(?:\.\d+)?)%\s*used"/i

  const sessionMatch = text.match(sessionRe)
  const weeklyMatch = text.match(weeklyRe)

  if (!sessionMatch && !weeklyMatch) {
    return null
  }

  const sessionPct = sessionMatch ? Number.parseFloat(sessionMatch[1]) : 0
  const weeklyPct = weeklyMatch ? Number.parseFloat(weeklyMatch[1]) : 0

  if (!Number.isFinite(sessionPct) || !Number.isFinite(weeklyPct)) {
    return null
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
    if (Number.isNaN(target)) {
      return null
    }
    const diff = Math.max(0, target - Date.now())
    return Math.round(diff / 1000)
  } catch {
    return null
  }
}
