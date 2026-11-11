import { describe, expect, it } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../../../shared/agent-session/agent-session-host-authority'
import { PaneLaunchArgsMemory } from './pane-launch-args-memory'

const base: RuntimeCreateAgentSessionRequest = {
  worktree: 'id:wt::/vercel/sandbox/project',
  agent: 'claude',
  clientOperationId: 'op',
  placement: { tabId: 'tab-1', leafId: 'leaf-1' }
}

describe('RA-11d: a bare relaunch of a pane reuses its original launch args', () => {
  it("reuses the create launch's args and preferences for the same pane and agent", () => {
    const memory = new PaneLaunchArgsMemory()
    memory.apply({
      ...base,
      agentArgs: '--model opus --effort high',
      launchPreferences: { model: 'opus' }
    })
    expect(memory.apply({ ...base, clientOperationId: 'op-2' })).toMatchObject({
      agentArgs: '--model opus --effort high',
      launchPreferences: { model: 'opus' }
    })
  })

  it('an explicit request wins and becomes the new memory', () => {
    const memory = new PaneLaunchArgsMemory()
    memory.apply({ ...base, agentArgs: '--model opus' })
    expect(memory.apply({ ...base, agentArgs: '--model sonnet' }).agentArgs).toBe('--model sonnet')
    expect(memory.apply(base).agentArgs).toBe('--model sonnet')
  })

  it('never crosses panes, agents or workspaces, and ignores unplaced launches', () => {
    const memory = new PaneLaunchArgsMemory()
    memory.apply({ ...base, agentArgs: '--model opus' })
    expect(
      memory.apply({ ...base, placement: { tabId: 'tab-4', leafId: 'leaf-1' } }).agentArgs
    ).toBeUndefined()
    expect(memory.apply({ ...base, agent: 'codex' }).agentArgs).toBeUndefined()
    expect(memory.apply({ ...base, worktree: 'id:other' }).agentArgs).toBeUndefined()
    const unplaced = { ...base, placement: undefined }
    memory.apply({ ...unplaced, agentArgs: '--x' })
    expect(memory.apply(unplaced).agentArgs).toBeUndefined()
  })
})
