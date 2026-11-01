import { randomUUID } from 'node:crypto'

import type { ProcessTerminationBarrier } from '@orca/process-host/process-spec'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { runWslProcess } from '../wsl/wsl-runner'
import { WSL_UNC_RUNNING_LEASE_MS, wslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { isWslUserActFor } from '../wsl/wsl-user-act-scope'
import { readWslDistroRunningState } from '../wsl-background-distro-gate'

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
  // When the guest proved it ran; a 'stopped' read probed before then cannot prove the group ended.
  let groupObservedAt = -Infinity
  let stderrTail = ''

  const observeStderr = (chunk: Buffer | string): void => {
    const combined = `${stderrTail}${chunk.toString()}`
    const match = combined.match(new RegExp(`${marker}(\\d+)\\r?\\n`))
    stderrTail = combined.slice(-512)
    const parsed = match ? Number(match[1]) : 0
    if (Number.isSafeInteger(parsed) && parsed > 1) {
      processGroupId = parsed
      groupObservedAt = performance.now()
    }
  }

  const terminate = async (signal: 'TERM' | 'KILL'): Promise<boolean> => {
    if (processGroupId === null) {
      return false
    }
    // A cancel or timeout can land after the distro stopped; a kill would boot it again (E9).
    // A confirmed stop already ended the group, while an unanswered read proves nothing.
    if (wslDistroForPath('', distro) && !isWslUserActFor(distro)) {
      const state = await readWslDistroRunningState(distro, {
        startedAfter: Math.max(groupObservedAt, performance.now() - WSL_UNC_RUNNING_LEASE_MS),
        retryUnverifiable: true
      })
      if (state !== 'running') {
        return state === 'stopped'
      }
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
    // Builtins/coreutils use the default PATH; a login probe only delays termination.
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
      // BusyBox setsid lacks --wait; without a new session, report no group to avoid killing another owner.
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
