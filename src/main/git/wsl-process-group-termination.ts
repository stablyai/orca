import { randomUUID } from 'node:crypto'
import type { ProcessTerminationBarrier } from '../../shared/child-process/run-process'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { runWslProcess } from '../wsl/wsl-runner'

const GUEST_TERMINATION_ATTEMPTS = 40
const GUEST_TERMINATION_INTERVAL_SECONDS = '0.025'
const GUEST_TERMINATION_COMMAND_TIMEOUT_MS = 5_000

export type WslProcessGroupTermination = ProcessTerminationBarrier & {
  wrapGuestArgs: (args: readonly string[]) => string[]
  stripControlOutput: (stderr: string) => string
}

export function createWslProcessGroupTermination(distro: string): WslProcessGroupTermination {
  const marker = `__ORCA_WSL_PROCESS_GROUP_${randomUUID()}__=`
  let processGroupId: number | null = null
  let stderrTail = ''

  const observeStderr = (chunk: Buffer | string): void => {
    const combined = `${stderrTail}${chunk.toString()}`
    const match = combined.match(new RegExp(`${marker}(\\d+)\\r?\\n`))
    stderrTail = combined.slice(-512)
    const parsed = match ? Number(match[1]) : 0
    if (Number.isSafeInteger(parsed) && parsed > 1) {
      processGroupId = parsed
    }
  }

  const terminate = async (signal: 'TERM' | 'KILL'): Promise<boolean> => {
    if (processGroupId === null) {
      return false
    }
    const script = [
      '_orca_group=$1',
      `kill -${signal} "-$_orca_group" 2>/dev/null || :`,
      '_orca_attempt=0',
      'while kill -0 "-$_orca_group" 2>/dev/null; do',
      `  [ "$_orca_attempt" -ge ${GUEST_TERMINATION_ATTEMPTS} ] && exit 1`,
      '  _orca_attempt=$((_orca_attempt + 1))',
      `  sleep ${GUEST_TERMINATION_INTERVAL_SECONDS}`,
      'done'
    ].join('\n')
    // loginPath 'none': the payload is builtins and coreutils on the default
    // PATH, so a login probe would only add latency to a kill.
    const result = await runWslProcess({
      script,
      args: [String(processGroupId)],
      distro,
      loginPath: 'none',
      timeoutMs: GUEST_TERMINATION_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 1_024
    })
    return result.code === 0 && !result.timedOut
  }

  return {
    observeStderr,
    signal: () => terminate('TERM'),
    force: () => terminate('KILL'),
    wrapGuestArgs: (args) => {
      const reportGroup = [
        `printf '%s%s\\n' ${quotePosixShell(marker)} "$$" >&2`,
        'exec "$@"'
      ].join('\n')
      // Why probe rather than assume: BusyBox `setsid` has no `--wait`, so there
      // the wrapper would fail the Git command outright. Without a new session the
      // reported group is not ours to kill, so the fallback reports no identity
      // and the caller falls back to waiting for the root exit.
      const script = [
        'if setsid --wait true 2>/dev/null; then',
        `  exec setsid --wait sh -c ${quotePosixShell(reportGroup)} orca-wsl-process-group "$@"`,
        'fi',
        'exec "$@"'
      ].join('\n')
      return ['sh', '-c', script, 'orca-wsl-process-group', ...args]
    },
    stripControlOutput: (stderr) => stderr.replace(new RegExp(`${marker}\\d+\\r?\\n?`, 'g'), '')
  }
}
