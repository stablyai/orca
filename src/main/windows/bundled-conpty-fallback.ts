// Failures specific to Orca's bundled conpty.dll path; pipe-creation failures are transient and stay out.
const BUNDLED_CONPTY_FAILURE_PREFIXES = [
  'Cannot launch conpty: ConptyCreatePseudoConsole failed',
  'Cannot launch conpty: GetProcAddress(ConptyCreatePseudoConsole) failed',
  'Failed to load conpty.dll',
  'Cannot find conpty.dll',
  'Failed to get conpty.node module'
]

// Set once the system ConPTY has replaced a failed bundled one; later spawns skip the bundled attempt.
let bundledConptyFailure: string | null = null

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
  if (bundledConptyFailure !== null) {
    return spawn(false)
  }
  try {
    return spawn(true)
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
    bundledConptyFailure = errorMessage(bundledError)
    console.warn(
      `[pty] Bundled ConPTY failed for "${label}" (${bundledConptyFailure}); using the system ConPTY for this process`
    )
    return proc
  }
}
