import { basename, win32 } from 'node:path'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
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
  return { command: `bash -lc ${quotePosixShell(script)}` }
}

export type NativeSetupCompletionShell = 'posix' | 'fish' | 'cmd' | 'powershell'

export function nativeSetupCompletionShell(
  executablePath: string
): NativeSetupCompletionShell | undefined {
  const name = win32.basename(basename(executablePath)).toLowerCase()
  if (name === 'cmd.exe') {
    return 'cmd'
  }
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    return 'powershell'
  }
  if (name === 'fish') {
    return 'fish'
  }
  return ['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash'].includes(name) ? 'posix' : undefined
}

export function nativeSetupCompletionToken(
  env: Record<string, string | undefined> | undefined
): string | undefined {
  const token = env?.ORCA_SETUP_COMPLETION_TOKEN
  return token?.startsWith('native:') ? token : undefined
}

export function stripNativeSetupCompletionEnvironment(env: Record<string, string>): void {
  if (nativeSetupCompletionToken(env)) {
    delete env.ORCA_SETUP_COMPLETION_TOKEN
  }
}

export function appendNativeSetupCompletion(
  command: string,
  token: string | undefined,
  shell: NativeSetupCompletionShell | undefined
): string {
  if (!token || !shell) {
    return command
  }
  const prefix = completionPrefix(token)
  if (shell === 'cmd') {
    return `${command} & call "%ComSpec%" /d /c "echo ${prefix}%%errorlevel%%&exit /b %%errorlevel%%"`
  }
  if (shell === 'powershell') {
    return `${command}; $__orca_success=$?; $__orca_status=$LASTEXITCODE; if ($__orca_success) { $__orca_status=0 } elseif (!$__orca_status) { $__orca_status=1 }; [Console]::WriteLine('${prefix}' + $__orca_status); if ($__orca_status -ne 0) { Write-Error 'setup failed' -ErrorAction Ignore }`
  }
  // Why one submission: a second stdin line could become the setup program's input.
  if (shell === 'fish') {
    return `${command}; begin; set -l __orca_status $status; printf '\\n${prefix}%s\\n' $__orca_status; /bin/sh -c 'exit "$1"' sh $__orca_status; end`
  }
  return `${command}; ( __orca_status=$?; printf '\\n${prefix}%s\\n' "$__orca_status"; exit "$__orca_status" )`
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

function completionPrefix(completionToken: string): string {
  return `${SETUP_COMPLETION_PREFIX}${completionToken}:`
}

export function createSetupCompletionObservation(token: string) {
  let finish: (exitCode: number | null) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const completion = new Promise<{ exitCode: number | null }>((resolve, reject) => {
    fail = reject
    finish = (exitCode) => resolve({ exitCode })
  })
  void completion.catch(() => {})
  return {
    token,
    completion,
    finish,
    fail,
    ...createSetupCompletionScanner(token, (code) => finish(code))
  }
}
