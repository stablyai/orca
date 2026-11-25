/** Reads a failed drain step without letting its stdout, which can hold the auth files, escape. */
import { isWslHostFailureExitCode } from '../../wsl/execution/wsl-process-failure'
import { INSPECT_STARTED_MARKER } from './legacy-wsl-runtime-auth-drain-scripts'

type DrainStepResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

const DETAIL_LIMIT = 300
const WSL_ERROR_CODE = /\bWsl\/[A-Za-z0-9_/]{1,100}/

/** wsl.exe failed before the inspect's first statement printed its marker, so no recovery ran. */
export function inspectNeverStarted(result: DrainStepResult): boolean {
  return (
    !result.timedOut &&
    isWslHostFailureExitCode(result.code) &&
    !result.stderr.trim() &&
    !result.stdout.includes(INSPECT_STARTED_MARKER)
  )
}

/** Inspect's payload after its marker line, or null when the marker does not open it. */
export function inspectPayload(stdout: string): string | null {
  const opening = `${INSPECT_STARTED_MARKER}\n`
  return stdout.startsWith(opening) ? stdout.slice(opening.length) : null
}

/** stderr, else wsl.exe's error code from an inspect no guest ran; never other stdout. */
export function describeDrainStepFailure(
  step: string,
  result: DrainStepResult,
  stdoutIsWslExeOnly = false
): string {
  const wslCode = stdoutIsWslExeOnly ? WSL_ERROR_CODE.exec(result.stdout)?.[0] : undefined
  const detail = result.stderr.trim().slice(0, DETAIL_LIMIT) || wslCode
  return `Legacy WSL auth drain ${step} failed (${result.timedOut ? 'timeout' : `exit ${result.code}`})${detail ? `: ${detail}` : ''}`
}
