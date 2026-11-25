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
