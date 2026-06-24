import { execFileSync, execFile } from 'child_process'

const PROBE_TIMEOUT_MS = 5000

// Why: a synchronous probe blocks the daemon's event loop, so it must stay
// short. But cold-starting pwsh.exe (first .NET JIT + Defender scan) routinely
// exceeds that, so the first terminal opened right after daemon start times out
// and silently falls back to Windows PowerShell. The warm probe runs once at
// startup, async (non-blocking) and with generous headroom, to populate the
// cache before the first terminal launch.
const WARM_PROBE_TIMEOUT_MS = 20_000

// Why: only a positive result is durably true — pwsh installs don't disappear
// mid-session, so caching `true` forever is safe and avoids re-spawning the probe
// on every terminal launch. A `false`, however, can be a transient failure (probe
// raced a busy startup) and, crucially, the terminal daemon is a detached process
// that outlives app restarts (see daemon-init.ts). Caching `false` for that whole
// lifetime keeps the PowerShell 7+ option dead for days and silently falls back to
// Windows PowerShell. So we remember a negative result only briefly and re-probe.
const NEGATIVE_CACHE_TTL_MS = 30_000

let pwshAvailableCache: boolean | null = null
let negativeProbedAt = 0

/** @internal - tests need a clean probe cache between cases. */
export function _resetPwshAvailableCache(): void {
  pwshAvailableCache = null
  negativeProbedAt = 0
}

/**
 * Check whether pwsh.exe is available on this Windows machine.
 * A positive result is cached for the process lifetime; a negative result is
 * cached only briefly so a one-off probe failure doesn't disable pwsh for the
 * whole session.
 */
export function isPwshAvailable(): boolean {
  if (pwshAvailableCache === true) {
    return true
  }

  if (process.platform !== 'win32') {
    pwshAvailableCache = false
    return false
  }

  if (pwshAvailableCache === false && Date.now() - negativeProbedAt < NEGATIVE_CACHE_TTL_MS) {
    return false
  }

  try {
    execFileSync('pwsh.exe', ['-Version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS
    })
    pwshAvailableCache = true
  } catch {
    pwshAvailableCache = false
    negativeProbedAt = Date.now()
  }

  return pwshAvailableCache
}

/**
 * Warm the pwsh availability cache without blocking the caller.
 * Only ever records a positive result — negatives are left to isPwshAvailable()
 * and its TTL re-probe, so a slow cold start here can't poison the cache.
 */
export function warmPwshAvailability(): void {
  if (process.platform !== 'win32' || pwshAvailableCache === true) {
    return
  }
  execFile('pwsh.exe', ['-Version'], { timeout: WARM_PROBE_TIMEOUT_MS }, (err) => {
    if (!err) {
      pwshAvailableCache = true
    }
  })
}
