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
// A line with no space or punctuation could be guest output (base64, single words); wsl.exe's text has them.
const GUEST_OUTPUT_LINE = /^[A-Za-z0-9+/=]+$/
const WSL_ERROR_CODE = /\bWsl\/[A-Za-z0-9_/]+/

/** wsl.exe's own error (capped), only for exit -1 with no guest output: proof the guest never ran. */
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
  const lines = diagnostic.split(/\r?\n/).filter((line) => line.trim())
  if (
    !WSL_ERROR_CODE.test(diagnostic) ||
    lines.some((line) => GUEST_OUTPUT_LINE.test(line.trim()))
  ) {
    return null
  }
  return diagnostic.slice(0, WSL_DIAGNOSTIC_LIMIT)
}
