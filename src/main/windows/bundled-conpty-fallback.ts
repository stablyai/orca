// Failures specific to Orca's bundled conpty.dll path; pipe-creation failures are transient and stay out.
const BUNDLED_CONPTY_FAILURE_PREFIXES = [
  'Cannot launch conpty: ConptyCreatePseudoConsole failed',
  'Cannot launch conpty: GetProcAddress(ConptyCreatePseudoConsole) failed',
  'Failed to load conpty.dll',
  'Cannot find conpty.dll',
  'Failed to get conpty.node module'
]

// Re-try the bundled ConPTY after this long or this many system spawns, so a one-off failure cannot pin a long-lived daemon.
export const BUNDLED_CONPTY_RETRY_AFTER_MS = 10 * 60_000
export const BUNDLED_CONPTY_RETRY_AFTER_SPAWNS = 20

type BundledConptyMemo = { message: string; at: number; systemSpawns: number }

// Set once the system ConPTY has replaced a failed bundled one; later spawns skip the bundled attempt until it expires.
let bundledConptyFailure: BundledConptyMemo | null = null
// Why separate from the memo: re-pinning after an expiry retry must not repeat the warning.
let fallbackLogged = false

function memoActive(memo: BundledConptyMemo): boolean {
  return (
    Date.now() - memo.at < BUNDLED_CONPTY_RETRY_AFTER_MS &&
    memo.systemSpawns < BUNDLED_CONPTY_RETRY_AFTER_SPAWNS
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isBundledConptyFailure(error: unknown): boolean {
  const message = errorMessage(error)
  return BUNDLED_CONPTY_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix))
}

/**
 * Spawn on the bundled ConPTY, retrying on the system ConPTY when the bundled DLL or its
 * console host cannot start (#47506). Off Windows this is a plain spawn.
 */
export function spawnWithSystemConptyFallback<T>(
  spawn: (useConptyDll: boolean) => T,
  label: string
): T {
  if (process.platform !== 'win32') {
    return spawn(false)
  }
  if (bundledConptyFailure !== null && memoActive(bundledConptyFailure)) {
    bundledConptyFailure.systemSpawns += 1
    return spawn(false)
  }
  try {
    const proc = spawn(true)
    if (bundledConptyFailure !== null) {
      bundledConptyFailure = null
      console.warn(`[pty] Bundled ConPTY works again for "${label}"; leaving the system ConPTY`)
    }
    return proc
  } catch (bundledError) {
    if (!isBundledConptyFailure(bundledError)) {
      throw bundledError
    }
    let proc: T
    try {
      proc = spawn(false)
    } catch (systemError) {
      // Why keep both: the bundled message names the DLL and HRESULT, the system one rules it in or out.
      throw new Error(
        `${errorMessage(bundledError)}; system ConPTY fallback also failed: ${errorMessage(systemError)}`
      )
    }
    // Why memo only on success: if both failed, the cause may be transient and not bundled-specific.
    bundledConptyFailure = { message: errorMessage(bundledError), at: Date.now(), systemSpawns: 0 }
    if (!fallbackLogged) {
      fallbackLogged = true
      console.warn(
        `[pty] Bundled ConPTY failed for "${label}" (${bundledConptyFailure.message}); using the system ConPTY and retrying the bundled one periodically`
      )
    }
    return proc
  }
}
