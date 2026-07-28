// Why: ollama.com/settings renders usage as aria-label="Session usage X% used"
// and aria-label="Weekly usage X% used". Match the full label for reliable
// disambiguation instead of searching for bare percentages.

type ParsedOllamaCloudUsage = {
  sessionPercent: number
  weeklyPercent: number
  sessionResetInSec: number | null
  weeklyResetInSec: number | null
}

/**
 * Parses ollama.com/settings HTML for usage percentage data.
 * Matches aria-label="Session usage X% used" and aria-label="Weekly usage X% used".
 * Both labels are always present for authenticated users; a missing label
 * means the page structure changed and the scrape is invalid.
 */
export function parseOllamaCloudFromPageText(text: string): ParsedOllamaCloudUsage | null {
  if (!text || text.length > 10_000_000) {
    return null
  }

  const sessionRe = /aria-label="Session usage\s+(\d+(?:\.\d+)?)%\s*used"/i
  const weeklyRe = /aria-label="Weekly usage\s+(\d+(?:\.\d+)?)%\s*used"/i

  const sessionMatch = text.match(sessionRe)
  const weeklyMatch = text.match(weeklyRe)

  // Why: both labels are always present for any logged-in user. If one is
  // missing the page structure changed — treat the scrape as invalid rather
  // than fabricating a 0% reading for the unmatched metric.
  if (!sessionMatch || !weeklyMatch) {
    return null
  }

  const sessionPct = Number.parseFloat(sessionMatch[1])
  const weeklyPct = Number.parseFloat(weeklyMatch[1])

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
