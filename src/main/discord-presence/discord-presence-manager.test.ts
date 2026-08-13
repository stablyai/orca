import { describe, it, expect, vi } from 'vitest'
import { DiscordPresenceManager } from './discord-presence-manager'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { DiscordRpcClient } from './discord-rpc-client'
import type { DiscordActivity } from './discord-presence-activity'

// Fakes for dependencies
function makeClient(): DiscordRpcClient & { setActivity: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onDisconnectCbs: Array<() => void> } {
  const cbs: Array<() => void> = []
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    setActivity: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    onDisconnect: vi.fn((cb: () => void) => { cbs.push(cb) }),
    onDisconnectCbs: cbs
  }
}

function workingEntry(agentType = 'claude', receivedAt = 1000): AgentStatusIpcPayload {
  return {
    state: 'working',
    paneKey: `pane-${Math.random().toString(36).slice(2)}`,
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    prompt: '',
    agentType
  }
}

describe('DiscordPresenceManager', () => {
  it('publishes activity on status change when enabled', () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
    const subscribeChanges = vi.fn()
    const client = makeClient()
    let enabled = true

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => enabled,
      assetKey: 'orca'
    })

    mgr.start()
    // subscribeChanges should have been called
    expect(subscribeChanges).toHaveBeenCalledTimes(1)

    // Trigger a change
    const changeCb = subscribeChanges.mock.calls[0][0] as () => void
    changeCb()

    // Should have called setActivity with the built activity
    expect(client.setActivity).toHaveBeenCalledTimes(1)
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.details).toBe('1 agent working')
    expect(activity.state).toBe('Claude')
    expect(activity.assets.large_image).toBe('orca')
  })

  it('clears activity when disabled', () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
    const subscribeChanges = vi.fn()
    const client = makeClient()
    let enabled = false

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => enabled,
      assetKey: 'orca'
    })

    mgr.start()
    const changeCb = subscribeChanges.mock.calls[0][0] as () => void
    // Trigger change while disabled
    changeCb()

    expect(client.setActivity).toHaveBeenCalledWith(null)
  })

  it('clears activity when no active agents', () => {
    const getSnapshot = vi.fn().mockReturnValue([])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca'
    })

    mgr.start()
    subscribeChanges.mock.calls[0][0]()
    expect(client.setActivity).toHaveBeenCalledWith(null)
  })

  it('stop() unsubscribes and disconnects', () => {
    const getSnapshot = vi.fn()
    const unsubscribe = vi.fn()
    const subscribeChanges = vi.fn().mockReturnValue(unsubscribe)
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca'
    })

    mgr.start()
    mgr.stop()

    expect(unsubscribe).toHaveBeenCalled()
    expect(client.disconnect).toHaveBeenCalled()
  })
})