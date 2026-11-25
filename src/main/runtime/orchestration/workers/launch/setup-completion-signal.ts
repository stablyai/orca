import { quotePosixShell } from '../../../../../shared/shell/launch/shell-argument-quoting'
import {
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from '../../../../../shared/agent-launch/startup/setup-runner-command'
import { setupCompletionMarkerPrefix } from '../../../../../shared/agent-launch/startup/setup-completion-marker'

// Room for the prefix, a token and the status.
const SETUP_COMPLETION_CARRY_LENGTH = setupCompletionMarkerPrefix('').length + 96
const WINDOWS_SETUP_RUNNER_ENV = 'ORCA_SETUP_RUNNER_PATH'

export function buildObservedSetupCommand(
  runnerScriptPath: string,
  platform: SetupRunnerCommandPlatform,
  completionToken: string,
  // Preserve runner shell selection so WSL drive paths stay /mnt/c rather than Git Bash /c.
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
      `Write-Output ('${setupCompletionMarkerPrefix(completionToken)}' + $status)`,
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

  // Why no `( … )`: this is typed into the user's line editor, where autopair widgets corrupt it (#18059).
  const script = [
    resolution.command,
    'status=$?',
    `printf '\\n${setupCompletionMarkerPrefix(completionToken)}%s\\n' "$status"`,
    'exit "$status"'
  ].join('; ')
  return { command: `bash -lc ${quotePosixShell(script)}` }
}

export function createSetupCompletionScanner(
  completionToken: string,
  onComplete: (exitCode: number) => void
): {
  scan: (data: string) => void
} {
  const expectedPrefix = setupCompletionMarkerPrefix(completionToken)
  let carry = ''
  let completed = false
  return {
    scan(data: string): void {
      if (completed || data.length === 0) {
        return
      }
      const combined = `${carry}${data}`
      const markerIndex = combined.lastIndexOf(expectedPrefix)
      if (markerIndex !== -1) {
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
