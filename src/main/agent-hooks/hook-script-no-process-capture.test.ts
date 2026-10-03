import { describe, expect, it } from 'vitest'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { getManagedScript } from '../claude/hook-script'

describe('hooks carry turn state without process capture', () => {
  it.each(['claude-hook', 'openclaude-hook'])('does not inspect parent processes in %s', (name) => {
    const command = wrapRuntimeHomeHookCommand(name)
    expect(command).not.toContain('ORCA_HOOK_AGENT_PID')
    expect(command).not.toContain('PPID')
  })
  it('does not generate process queries in the managed script', () => {
    const script = getManagedScript('posix')
    expect(script).not.toContain('ORCA_HOOK_AGENT_PID')
    expect(script).not.toContain('/bin/ps')
    expect(script).not.toContain('/proc/')
  })
})
