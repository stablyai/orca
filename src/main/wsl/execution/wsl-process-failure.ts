/** wsl.exe's own launch-failure exit, distinct from any status the guest process can return. */
const WSL_HOST_FAILURE_EXIT_CODE = 0xffffffff

/** Node reports the unsigned DWORD; >>> 0 also folds a signed -1. */
export function isWslHostFailureExitCode(code: number | null | undefined): boolean {
  return typeof code === 'number' && code >>> 0 === WSL_HOST_FAILURE_EXIT_CODE
}

/** wsl.exe writes its own errors to stdout; strip UTF-16LE NULs left when WSL_UTF8 was ignored. */
export function readWslHostDiagnostic(stdout: string): string {
  return stdout.replaceAll('\u0000', '').trim()
}

/** Why a guest command failed: its stderr, else wsl.exe's own error, else the exit status. */
export function describeWslProcessFailure(result: {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}): string {
  const stderr = result.stderr.trim()
  if (stderr) {
    return stderr
  }
  if (result.timedOut) {
    return 'timed out'
  }
  if (isWslHostFailureExitCode(result.code)) {
    const diagnostic = readWslHostDiagnostic(result.stdout)
    return diagnostic ? `wsl.exe: ${diagnostic}` : 'wsl.exe could not start the command.'
  }
  return `exited with code ${result.code ?? 'unknown'}`
}

export const WSL_DIAGNOSTIC_LIMIT = 300
const WSL_ERROR_CODE = /\bWsl\/[A-Za-z0-9_/]+/
// Any long base64 run is guest output (auth files are printed encoded), wherever it sits.
const GUEST_BASE64_RUN = /[A-Za-z0-9+/=]{40,}/
// wsl.exe's text opens with a word; a longer base64-alphabet token is guest bytes glued in front.
const WSL_TEXT_OPENING = /^(?:[^\sA-Za-z0-9+/=]|[A-Za-z0-9+/=]{1,16}(?:\s|$|[^A-Za-z0-9+/=]))/

/**
 * wsl.exe's own error code, only for exit -1 whose stdout is wsl.exe's text alone: evidence the
 * guest never ran. Returns just the code, so no stdout text can reach a message or log.
 */
export function readWslExeFailureBeforeGuest(result: {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}): string | null {
  if (result.timedOut || !isWslHostFailureExitCode(result.code) || result.stderr.trim()) {
    return null
  }
  const diagnostic = readWslHostDiagnostic(result.stdout)
  if (GUEST_BASE64_RUN.test(diagnostic) || !WSL_TEXT_OPENING.test(diagnostic)) {
    return null
  }
  return WSL_ERROR_CODE.exec(diagnostic)?.[0] ?? null
}
