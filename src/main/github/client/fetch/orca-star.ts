import { ghExecFileAsync, acquire, release } from '../../gh-utils'
export const ORCA_REPO = 'stablyai/orca'

/**
 * Deadline for the two star-nag gh calls.
 *
 * Why bounded at all: these are the only gh call sites that used the raw
 * `execFileAsync`, so a `gh` that never exits blocked forever, never released
 * its GitHub concurrency slot, and left the child running (#18234). Why shorter
 * than the 30s gh default: nothing here is user-visible work — the nag falls
 * back to the browser button — so a slow answer is worth less than a bounded one.
 */
const STAR_GH_TIMEOUT_MS = 15_000

let inFlightStarCheck: Promise<boolean | null> | null = null

/**
 * Check if the authenticated user has starred the Orca repo.
 * Returns true if starred, false if not, null if unable to determine (gh unavailable).
 */
export function checkOrcaStarred(): Promise<boolean | null> {
  // Why: five independent callers (landing button, settings section, threshold
  // nag, agent-value moment, force-show) can ask at once and none of them knows
  // about the others. Without coalescing, each forks its own `gh`, and four
  // stuck children exhaust the 4-wide GitHub semaphore for the app's lifetime.
  inFlightStarCheck ??= runOrcaStarredCheck().finally(() => {
    inFlightStarCheck = null
  })
  return inFlightStarCheck
}

/** @internal Drop any coalesced check so suites cannot inherit one another's. */
export function __resetOrcaStarCheckForTests(): void {
  inFlightStarCheck = null
}

async function runOrcaStarredCheck(): Promise<boolean | null> {
  await acquire()
  try {
    const { stdout, stderr } = await ghExecFileAsync(
      ['api', '--include', `user/starred/${ORCA_REPO}`],
      { encoding: 'utf-8', timeout: STAR_GH_TIMEOUT_MS }
    )
    const response = `${stdout ?? ''}\n${stderr ?? ''}`
    if (/HTTP\/\S+\s+(?:200|204)\b/.test(response)) {
      return true
    }
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 404 means the user hasn't starred — the only expected "no" answer
    if (message.includes('HTTP 404')) {
      return false
    }
    // Anything else (gh not installed, not authenticated, network issue, timeout)
    return null
  } finally {
    release()
  }
}

/**
 * Star the Orca repo for the authenticated user.
 */
export async function starOrca(): Promise<boolean> {
  await acquire()
  try {
    await ghExecFileAsync(['api', '-X', 'PUT', `user/starred/${ORCA_REPO}`], {
      encoding: 'utf-8',
      timeout: STAR_GH_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  } finally {
    release()
  }
}
