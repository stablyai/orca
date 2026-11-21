import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'

const identity = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  sessionId: 'parent-session',
  instanceId: 'instance'
}

afterEach(() => vi.useRealTimers())

describe('Claude agent view delivery', () => {
  it('delivers requests once to the matching live mod and lets a parent view supersede a child', async () => {
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

    const child = bridge.view({ ...identity, agentId: 'another-child', trigger })
    const takenChild = bridge.receive({ ...identity, action: 'take' })
    expect(takenChild).toMatchObject({ agentId: 'another-child' })
    const parent = bridge.view({ ...identity, trigger })
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

  it('keeps an idle Claude viewable after main restarts, since its mod does not register again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-view-'))
    try {
      const file = join(dir, 'claude-agent-views.json')
      const before = new ClaudeAgentViewBridge()
      await before.restore(file)
      before.receive({
        ...identity,
        action: 'register',
        view: { agentId: 'previous', revision: 1 },
        keybindings: JSON.stringify({
          bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+h': 'command:orca-agent-view' } }]
        })
      })
      await vi.waitFor(() =>
        expect(existsSync(file) && readFileSync(file, 'utf8')).toContain('"previous"')
      )
      before.close()

      // A Claude that registers while the next main is still reading the file must not erase it.
      const other = { ...identity, paneKey: 'tab:22222222-2222-4222-8222-222222222222' }
      const racing = new ClaudeAgentViewBridge()
      const restored = racing.restore(file)
      racing.receive({ ...other, action: 'register', keybindings: binding('ctrl+alt+h') })
      await restored
      await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain(other.paneKey))
      expect(readFileSync(file, 'utf8')).toContain(identity.paneKey)
      racing.close()

      const after = new ClaudeAgentViewBridge()
      await after.restore(file)
      const trigger = vi.fn(async () => true)
      const result = after.view({ ...identity, agentId: 'child', trigger })
      await vi.waitFor(() =>
        expect(trigger).toHaveBeenCalledWith('\u001b[104;7u', expect.any(Function))
      )
      const taken = after.receive({ ...identity, action: 'take' })
      expect(taken).toMatchObject({ agentId: 'child' })
      after.receive({ ...identity, action: 'ack', ...taken })
      expect(await result).toEqual({ status: 'viewed' })
      expect(after.receive({ ...identity, instanceId: 'other', action: 'take' })).toEqual({
        unknown: true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('types the shortcut the user binds now, since an idle mod does not re-read its keybindings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-view-'))
    try {
      const keybindings = join(dir, 'keybindings.json')
      writeFileSync(keybindings, binding('ctrl+alt+g'))
      const bridge = new ClaudeAgentViewBridge()
      bridge.receive(
        {
          ...identity,
          action: 'register',
          configDir: dir,
          view: { agentId: 'previous', revision: 1 },
          keybindings: binding('ctrl+alt+g')
        },
        { sameMachine: true }
      )
      writeFileSync(keybindings, binding('ctrl+alt+h'))
      const trigger = vi.fn(async () => true)
      const result = bridge.view({ ...identity, agentId: 'child', trigger })
      await vi.waitFor(() =>
        expect(trigger).toHaveBeenCalledWith('\u001b[104;7u', expect.any(Function))
      )
      bridge.receive({
        ...identity,
        action: 'ack',
        ...bridge.receive({ ...identity, action: 'take' })
      })
      expect(await result).toEqual({ status: 'viewed' })

      writeFileSync(keybindings, JSON.stringify({ bindings: [] }))
      trigger.mockClear()
      expect(await bridge.view({ ...identity, agentId: 'other-child', trigger })).toEqual({
        status: 'unsupported'
      })
      expect(trigger).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function binding(chord: string): string {
  return JSON.stringify({
    bindings: [{ context: 'Chat', bindings: { [chord]: 'command:orca-agent-view' } }]
  })
}
