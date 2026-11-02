import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  resolveSetupRunnerCommand,
  type SetupRunnerCommandPlatform,
  type SetupRunnerShell
} from '../../../shared/setup-runner-command'

const SETUP_COMPLETION_PREFIX = '__ORCA_SETUP_COMPLETE__:'
const SETUP_COMPLETION_CARRY_LENGTH = SETUP_COMPLETION_PREFIX.length + 96
const WINDOWS_SETUP_RUNNER_ENV = 'ORCA_SETUP_RUNNER_PATH'
// Long enough for a record split across reads, short enough that held look-alike text is unnoticed.
const SETUP_COMPLETION_HOLD_MS = 50

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

  // Why no `( … )`: this is typed into the user's line editor, where autopair widgets corrupt it (#18059).
  const script = [
    resolution.command,
    'status=$?',
    `printf '\\n${completionPrefix(completionToken)}%s\\n' "$status"`,
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

/**
 * Removes one Setup attempt's completion records from what the terminal shows and saves; every
 * other byte passes unchanged. A tail that may begin a record waits for the next chunk, a flush
 * (exit) or a quiet moment, so text that only starts like one is never kept back.
 */
export function hideSetupCompletionRecords(
  completionToken: string,
  emit: (data: string) => void
): { write: (data: string) => void; flush: () => void } {
  const prefix = completionPrefix(completionToken)
  let held = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    const data = held
    held = ''
    if (data) {
      emit(data)
    }
  }
  return {
    write(data: string): void {
      clearTimeout(timer)
      timer = undefined
      const text = held + data
      let shown = ''
      let from = 0
      held = ''
      for (let start = text.indexOf(prefix); start !== -1; start = text.indexOf(prefix, from)) {
        const end = completionRecordEnd(text, start + prefix.length)
        if (end === undefined) {
          held = text.slice(start)
          break
        }
        shown += text.slice(from, end === -1 ? start + prefix.length : start)
        from = end === -1 ? start + prefix.length : end
      }
      if (!held) {
        const tail = possibleRecordStart(text, from, prefix)
        held = text.slice(tail)
        shown += text.slice(from, tail)
      } else {
        shown += text.slice(from, text.length - held.length)
      }
      if (shown) {
        emit(shown)
      }
      if (held) {
        timer = setTimeout(flush, SETUP_COMPLETION_HOLD_MS)
        timer.unref?.()
      }
    },
    flush
  }
}

/** End of the exit status and its one line end; undefined until the chunk shows it, -1 when not a record. */
function completionRecordEnd(text: string, statusStart: number): number | undefined {
  let index = text[statusStart] === '-' ? statusStart + 1 : statusStart
  const digitsStart = index
  while (index < text.length && text[index] >= '0' && text[index] <= '9') {
    index += 1
  }
  if (index === text.length) {
    return undefined
  }
  if (index === digitsStart) {
    return -1
  }
  if (text[index] === '\n') {
    return index + 1
  }
  if (text[index] !== '\r') {
    return index
  }
  if (index + 1 === text.length) {
    return undefined
  }
  return text[index + 1] === '\n' ? index + 2 : index
}

function possibleRecordStart(text: string, from: number, prefix: string): number {
  for (let index = Math.max(from, text.length - prefix.length + 1); index < text.length; index++) {
    if (text[index] === prefix[0] && prefix.startsWith(text.slice(index))) {
      return index
    }
  }
  return text.length
}

function completionPrefix(completionToken: string): string {
  return `${SETUP_COMPLETION_PREFIX}${completionToken}:`
}
