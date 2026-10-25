import { basename, win32 } from 'node:path'
import { createStrictTerminalEscapeScanner } from '../../../shared/terminal-escape-scanner'
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
  const prefix = `ORCA_SETUP_DONE:${token}:`
  if (shell === 'cmd') {
    // Defer status to CALL after setup; the child-body quotes protect its separator on reparse.
    return `${command} & call "%ComSpec%" /d /c ^"echo ${prefix}%^errorlevel%;^&exit /b %^errorlevel%^"`
  }
  if (shell === 'powershell') {
    return `${command}; $__orca_success=$?; $__orca_status=$LASTEXITCODE; if ($__orca_success) { $__orca_status=0 } elseif (!$__orca_status) { $__orca_status=1 }; [Console]::WriteLine('${prefix}' + $__orca_status + ';'); if ($__orca_status -ne 0) { Write-Error 'setup failed' -ErrorAction Ignore }`
  }
  // Why one submission: a second stdin line could become the setup program's input.
  if (shell === 'fish') {
    return `${command}; begin; set -l __orca_status $status; printf '\\n${prefix}%s;\\n' $__orca_status; /bin/sh -c 'exit "$1"' sh $__orca_status; end`
  }
  return `${command}; ( __orca_status=$?; printf '\\n${prefix}%s;\\n' "$__orca_status"; exit "$__orca_status" )`
}

export function createSetupCompletionScanner(
  completionToken: string,
  onComplete: (exitCode: number) => void
): {
  scan: (data: string) => void
  interrupt: () => void
} {
  if (completionToken.startsWith('native:')) {
    return createNativeSetupCompletionScanner(completionToken, onComplete)
  }
  const expectedPrefix = completionPrefix(completionToken)
  let carry = ''
  let completed = false
  return {
    interrupt(): void {},
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

function createNativeSetupCompletionScanner(token: string, onComplete: (code: number) => void) {
  const current = `ORCA_SETUP_DONE:${token}:`
  const legacy = completionPrefix(token)
  let candidate = ''
  let completed = false
  const reset = (): void => {
    candidate = ''
  }
  const accept = (terminator: string): void => {
    const prefix = terminator === ';' ? current : legacy
    if (!candidate.startsWith(prefix)) {
      return
    }
    const number = candidate.slice(prefix.length).replace(/\r$/, '')
    if (!/^-?\d{1,10}$/.test(number)) {
      return
    }
    const code = Number(number)
    if (code < -2147483648 || code > 4294967295) {
      return
    }
    completed = true
    onComplete(code)
  }
  const lexer = createStrictTerminalEscapeScanner({
    onText(text) {
      if (completed) {
        return
      }
      if (text === ';') {
        accept(';')
        reset()
        return
      }
      candidate += text
      if (current.startsWith(candidate) || legacy.startsWith(candidate)) {
        return
      }
      const prefix = candidate.startsWith(current)
        ? current
        : candidate.startsWith(legacy)
          ? legacy
          : null
      if (prefix && /^-?\d{0,10}$/.test(candidate.slice(prefix.length))) {
        return
      }
      candidate = text === current[0] || text === legacy[0] ? text : ''
    },
    onControl(control, ground) {
      if (completed) {
        return
      }
      if (ground && control === '\n') {
        accept('\n')
      }
      if (ground && control === '\r' && candidate.startsWith(legacy) && !candidate.endsWith('\r')) {
        candidate += '\r'
      } else {
        reset()
      }
    }
  })
  return {
    scan: (data: string): void => {
      if (!completed) {
        lexer.observe(data)
      }
    },
    interrupt: reset
  }
}

function completionPrefix(completionToken: string): string {
  return `${SETUP_COMPLETION_PREFIX}${completionToken}:`
}

export function createSetupCompletionObservation(token: string, fromSpawn = false) {
  let settled = false
  let finish: (exitCode: number | null) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const completion = new Promise<{ exitCode: number | null }>((resolve, reject) => {
    fail = (error) => {
      settled = true
      reject(error)
    }
    finish = (exitCode) => {
      settled = true
      resolve({ exitCode })
    }
  })
  void completion.catch(() => {})
  let unknown = token.startsWith('native:') && !fromSpawn
  let sourceEnd = 0
  let published = !fromSpawn
  let pendingCode: number | undefined
  const scanner = createSetupCompletionScanner(token, (code) => {
    settled = true
    pendingCode = code
    if (published) {
      finish(code)
    }
  })
  return {
    token,
    get unknown() {
      return unknown
    },
    publish(): void {
      published = true
      if (pendingCode !== undefined) {
        finish(pendingCode)
      }
    },
    noteGap(): void {
      if (!settled && token.startsWith('native:')) {
        unknown = true
      }
    },
    scan(data: string, rawLength = data.length, transformed = false, seq?: number): void {
      if (unknown || settled) {
        return
      }
      if (token.startsWith('native:')) {
        if (!data.length && rawLength === 0 && !transformed && seq === undefined) {
          return
        }
        if (seq === undefined || seq - rawLength !== sourceEnd) {
          unknown = true
          return
        }
        sourceEnd = seq
        if (transformed && data.length === 0) {
          scanner.interrupt()
        }
      }
      scanner.scan(data)
    },
    completion,
    finish,
    fail
  }
}
