import {
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from '../../../shared/setup-runner-command'

const SETUP_COMPLETION_PREFIX = '__ORCA_SETUP_COMPLETE__:'
const SETUP_COMPLETION_CARRY_LENGTH = SETUP_COMPLETION_PREFIX.length + 96
const WINDOWS_SETUP_RUNNER_ENV = 'ORCA_SETUP_RUNNER_PATH'

export function buildObservedSetupCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  completionToken: string,
  // Why: the observed command must reuse the shell the runner was written for, or a
  // WSL-routed Windows-drive runner gets Git Bash `/c/...` instead of `/mnt/c/...`.
  shell?: SetupRunnerShell
): { command: string; env?: Record<string, string> } {
  const resolution = resolveSetupRunnerCommand(runnerScriptPath, platform, shell)
  if (resolution.shell === 'windows') {
    const script = [
      `$runner = $env:${WINDOWS_SETUP_RUNNER_ENV}`,
      '& $runner',
      '$succeeded = $?',
      '$status = $LASTEXITCODE',
      'if ($null -eq $status) { $status = if ($succeeded) { 0 } else { 1 } }',
      `Write-Output ('${completionPrefix(completionToken)}' + $status)`,
      'exit $status'
    ].join('; ')
    return {
      command: `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
        script,
        'utf16le'
      ).toString('base64')}`,
      env: { [WINDOWS_SETUP_RUNNER_ENV]: resolution.runnerScriptPathForShell }
    }
  }

  const script = [
    `( ${resolution.command} )`,
    'status=$?',
    `printf '\\n${completionPrefix(completionToken)}%s\\n' "$status"`,
    'exit "$status"'
  ].join('; ')
  return { command: `bash -lc ${quotePosixArg(script)}` }
}

export function createSetupCompletionScanner(
  completionToken: string,
  onComplete: (exitCode: number) => void
): {
  scan: (data: string) => void
} {
  const expectedPrefix = completionPrefix(completionToken)
  let carry = ''
  let completed = false
  return {
    scan(data: string): void {
      if (completed || data.length === 0) {
        return
      }
      const combined = `${carry}${data}`
      const markerIndex = combined.lastIndexOf(expectedPrefix)
      if (markerIndex >= 0) {
        const suffix = combined.slice(markerIndex + expectedPrefix.length)
        const match = suffix.match(/^(-?\d+)\r?\n/)
        if (match) {
          completed = true
          onComplete(Number.parseInt(match[1], 10))
          return
        }
      }
      carry = combined.slice(-SETUP_COMPLETION_CARRY_LENGTH)
    }
  }
}

function completionPrefix(completionToken: string): string {
  return `${SETUP_COMPLETION_PREFIX}${completionToken}:`
}

function quotePosixArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
