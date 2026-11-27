import { describe, expect, it } from 'vitest'
import { CLAUDE_MANAGED_HOOK_COMMAND_PATTERN } from '../../../shared/agent-hook-listener/providers/claude/claude-hook-plugin'
import { wrapWindowsDirectCmdHookCommand } from '../../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import { getRemoteManagedEventCommand, getWindowsManagedLifecycleHook } from './hook-settings'

// The pane's claude shell function greps settings.json text with this pattern so it never loads Orca's hooks twice.
const detects = (command: string): boolean =>
  new RegExp(CLAUDE_MANAGED_HOOK_COMMAND_PATTERN).test(
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }, null, 2)
  )

describe('CLAUDE_MANAGED_HOOK_COMMAND_PATTERN', () => {
  it('recognizes every command form Orca writes for Claude', () => {
    const posix = '/home/u/.orca/agent-hooks/claude-hook.sh'
    const nativeExe = 'C:\\Users\\u\\.orca\\agent-hooks\\orca-agent-hook.exe'
    const encoded = getWindowsManagedLifecycleHook(
      'C:\\Users\\Zoë & Co\\.orca\\agent-hooks\\claude-hook.cmd'
    ).command

    expect(encoded).toMatch(/^\S+powershell\.exe -NoProfile -EncodedCommand \S+$/)
    expect(detects(encoded)).toBe(true)
    expect(detects(getRemoteManagedEventCommand('Stop', posix))).toBe(true)
    expect(detects(getRemoteManagedEventCommand('PostCompact', posix))).toBe(true)
    expect(
      detects(
        getWindowsManagedLifecycleHook('C:\\Users\\u\\.orca\\agent-hooks\\claude-hook.cmd').command
      )
    ).toBe(true)
    expect(detects(`${wrapWindowsDirectCmdHookCommand(nativeExe)} claude`)).toBe(true)
    expect(detects(nativeExe)).toBe(true)
    expect(detects('C:\\Users\\u\\.orca\\agent-hooks\\claude-hook.cmd')).toBe(true)
  })

  it("leaves a user's own hooks alone", () => {
    expect(detects('/usr/local/bin/notify.sh --stop')).toBe(false)
    expect(detects('powershell.exe -NoProfile -EncodedCommand SQBuAHYAbwBrAGUA')).toBe(false)
  })
})
