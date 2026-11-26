// Native messages thrown only when Orca's bundled conpty.dll path fails; the system ConPTY skips them.
const BUNDLED_CONPTY_FAILURE_PREFIXES = [
  'Cannot launch conpty',
  'Failed to load conpty.dll',
  'Cannot find conpty.dll',
  'Failed to get conpty.node module'
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isBundledConptyFailure(error: unknown): boolean {
  const message = errorMessage(error)
  return BUNDLED_CONPTY_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix))
}

/**
 * Spawn on the bundled ConPTY, retrying once on the system ConPTY when the bundled
 * DLL or its console host cannot start (#47506). Other spawn errors propagate as-is.
 */
export function spawnWithSystemConptyFallback<T>(
  spawn: (useConptyDll: boolean) => T,
  label: string
): T {
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
    console.warn(
      `[daemon/pty] Bundled ConPTY failed for "${label}" (${errorMessage(bundledError)}); using the system ConPTY`
    )
    return proc
  }
}
