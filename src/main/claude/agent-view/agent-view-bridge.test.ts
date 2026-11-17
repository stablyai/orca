import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'

const identity = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  sessionId: 'parent-session',
  instanceId: 'instance'
}

afterEach(() => vi.useRealTimers())

describe('Claude agent view delivery', () => {
  it('requires a matching live mod and its acknowledgement, and consumes each request once', async () => {
    const bridge = new ClaudeAgentViewBridge()
    const trigger = vi.fn(async () => true)
    expect(await bridge.view({ ...identity, agentId: 'child', trigger })).toEqual({
      status: 'unsupported'
    })
    expect(trigger).not.toHaveBeenCalled()
    bridge.receive({
      ...identity,
      action: 'register',
      view: { agentId: 'previous', revision: 1 },
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    expect(await bridge.view({ ...identity, sessionId: 'another-session', trigger })).toEqual({
      status: 'unsupported'
    })
    let settled = false
    const result = bridge.view({ ...identity, agentId: 'child', trigger }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const taken = bridge.receive({ ...identity, action: 'take' })
    expect(taken).toMatchObject({ agentId: 'child' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
    bridge.receive({ ...identity, action: 'ack', ...taken, deny: 'no agent under that id' })
    expect(await result).toEqual({ status: 'denied', reason: 'no agent under that id' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
  })

  it('lets a parent click supersede a child that is still opening and ignores its late acknowledgement', async () => {
    const bridge = new ClaudeAgentViewBridge()
    bridge.receive({
      ...identity,
      action: 'register',
      view: { agentId: 'previous', revision: 1 },
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const child = bridge.view({ ...identity, agentId: 'child', trigger: async () => true })
    const takenChild = bridge.receive({ ...identity, action: 'take' })
    const parent = bridge.view({ ...identity, trigger: async () => true })
    expect(await child).toEqual({ status: 'busy' })
    const takenParent = bridge.receive({ ...identity, action: 'take' })
    expect(takenParent.requestId).not.toBe(takenChild.requestId)
    expect(takenParent.agentId).toBeUndefined()
    bridge.receive({ ...identity, action: 'ack', ...takenChild, deny: 'the view moved meanwhile' })
    bridge.receive({ ...identity, action: 'ack', ...takenParent })
    expect(await parent).toEqual({ status: 'viewed' })
  })

  it('expires a swallowed trigger so a later shortcut cannot switch views', async () => {
    vi.useFakeTimers()
    const bridge = new ClaudeAgentViewBridge()
    bridge.receive({
      ...identity,
      action: 'register',
      view: { agentId: 'previous', revision: 1 },
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const result = bridge.view({ ...identity, agentId: 'child', trigger: async () => true })
    await vi.advanceTimersByTimeAsync(1600)
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
    await vi.advanceTimersByTimeAsync(4000)
    expect(await result).toEqual({ status: 'timeout' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
  })
})
