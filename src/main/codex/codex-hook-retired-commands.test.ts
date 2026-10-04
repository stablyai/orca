import { describe, expect, it } from 'vitest'
import {
  buildWindowsHookPowerShellCommand,
  wrapPosixHookCommand,
  wrapWindowsHookCommand
} from '../agent-hooks/installer-utils'
import { buildCodexHookCommand } from './codex-hook-command-form'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { isRetiredCodexHookCommand } from './codex-hook-retired-commands'

// Frozen from the real-home lane's Windows launcher before Windows left that lane.
function encodedLauncher(scriptPath: string): string {
  const quoted = `'${scriptPath.replaceAll("'", "''")}'`
  const script = `if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`
  return `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

describe('isRetiredCodexHookCommand', () => {
  it.each([
    ['the #1019 double-quoted form', '/bin/sh "/u/Library/orca/agent-hooks/codex-hook.sh"'],
    [
      'the #1536 exec-guarded form',
      "if [ -x '/u/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/u/.orca/agent-hooks/codex-hook.sh'; fi"
    ],
    [
      'an exec-guarded form with a quoted apostrophe',
      "if [ -x '/u/o'\\''k/agent-hooks/codex-hook.sh' ]; then /bin/sh '/u/o'\\''k/agent-hooks/codex-hook.sh'; fi"
    ],
    [
      'a per-userData Windows path',
      'C:\\Users\\u\\AppData\\Roaming\\orca\\agent-hooks\\codex-hook.cmd'
    ],
    [
      "the real-home lane's first file-guarded form",
      "if [ -f '/u/.orca/agent-hooks/codex-hook.sh' ] && [ -r '/u/.orca/agent-hooks/codex-hook.sh' ] && [ -x '/u/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/u/.orca/agent-hooks/codex-hook.sh'; else cat >/dev/null 2>&1 || :; fi"
    ],
    [
      "the real-home lane's encoded Windows launcher",
      encodedLauncher("C:\\Users\\Jo O'Neil\\.orca\\agent-hooks\\codex-hook.cmd")
    ]
  ])('matches %s', (_case, command) => {
    expect(isRetiredCodexHookCommand(command)).toBe(true)
  })

  // Why: every build writes the frozen form and older builds still write theirs;
  // sweeping either would strip a live entry another Orca relies on.
  it.each([
    ["this build's command", getManagedCommand(getManagedScriptPath())],
    [
      "this build's cmd.exe spelling for a spaced profile",
      buildCodexHookCommand('C:\\Users\\Jo Smith\\.orca\\agent-hooks\\codex-hook.cmd', 'win32', {
        SystemRoot: 'C:\\Windows'
      })
    ],
    [
      "this build's cmd.exe spelling with Windows on another drive",
      buildCodexHookCommand('C:\\Users\\Jo Smith\\.orca\\agent-hooks\\codex-hook.cmd', 'win32', {
        SystemRoot: 'D:\\Windows'
      })
    ],
    [
      'the bare-cmd spelling that the managed installer and app start convert',
      'cmd --% /d /c @"C:/Users/Jo Smith/.orca/agent-hooks/codex-hook.cmd"'
    ],
    [
      'the PowerShell-text form that app start converts',
      "<# orca-agent-hook-form=1 #> if ($env:ORCA_PANE_KEY) { & 'C:/Users/Jo Smith/.orca/agent-hooks/codex-hook.cmd' }; exit 0"
    ],
    ["an older build's command", wrapPosixHookCommand('/other/.orca/agent-hooks/codex-hook.sh')],
    [
      "an older build's Windows launcher",
      buildWindowsHookPowerShellCommand('C:\\Users\\Jo Smith\\.orca\\agent-hooks\\codex-hook.cmd')
    ],
    [
      'the shared encoded launcher',
      wrapWindowsHookCommand('C:\\Users\\Jo Smith\\.orca\\agent-hooks\\codex-hook.cmd')
    ],
    ['a user script with the same name', '/bin/sh "/u/bin/codex-hook.sh"'],
    [
      "another agent's encoded launcher",
      encodedLauncher('C:\\Users\\Jo Smith\\.orca\\agent-hooks\\claude-hook.cmd')
    ],
    ['a user hook', 'my-stop-hook.sh'],
    ['no command', undefined]
  ])('leaves %s alone', (_case, command) => {
    expect(isRetiredCodexHookCommand(command)).toBe(false)
  })
})
