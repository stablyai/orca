import { shellEscape } from '../ssh/ssh-connection-utils'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
import {
  assertWslAccountExecutionTarget,
  type WslAccountExecutionContext
} from '../wsl/wsl-account-execution-context'

/** Recheck the captured UID/home in the same guest shell before reading or mutating credentials. */
export function runCapturedCodexWslProcess(spec: WslSpec, execution?: WslAccountExecutionContext) {
  if (!execution) {
    return runWslProcess(spec)
  }
  assertWslAccountExecutionTarget(execution, { runtime: 'wsl', wslDistro: spec.distro })
  if (spec.script === undefined) {
    throw new Error('Captured Codex account operations require a script')
  }
  const guard = `[ "$(id -u)" = ${shellEscape(execution.userId)} ] && [ "$HOME" = ${shellEscape(execution.home)} ] || { echo 'WSL account owner changed' >&2; exit 79; }`
  return runWslProcess({ ...spec, user: execution.userName, script: `${guard}\n${spec.script}` })
}
