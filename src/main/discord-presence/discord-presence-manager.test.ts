import { describe, it, expect, vi } from 'vitest'
import { DiscordPresenceManager } from './discord-presence-manager'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { DiscordActivity } from './discord-presence-activity'

// Fakes for dependencies
function makeClient() {
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

// Flush microtasks so the async connectAndPublish resolves
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('DiscordPresenceManager', () => {
  it('connects and publishes initial activity on start', async () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
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
    expect(subscribeChanges).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledTimes(1)

    await flush()

    // Initial publish after connect
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.details).toBe('1 agent working')
    expect(activity.state).toBe('Claude')
    expect(activity.assets.large_image).toBe('orca')
  })

  it('does not connect when disabled', async () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => false,
      assetKey: 'orca'
    })

    mgr.start()
    await flush()

    expect(client.connect).not.toHaveBeenCalled()
    expect(client.setActivity).not.toHaveBeenCalled()
  })

  it('publishes activity on status change when connected', async () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca',
      throttleIntervalMs: 0
    })

    mgr.start()
    await flush()
    client.setActivity.mockClear()

    const changeCb = subscribeChanges.mock.calls[0][0] as () => void
    changeCb()

    expect(client.setActivity).toHaveBeenCalledTimes(1)
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.details).toBe('1 agent working')
  })

  it('publishes idle activity when no active agents', async () => {
    const getSnapshot = vi.fn().mockReturnValue([])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca',
      throttleIntervalMs: 0
    })

    mgr.start()
    await flush()
    client.setActivity.mockClear()

    subscribeChanges.mock.calls[0][0]()
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.details).toBe('Idle')
  })

  it('forwards active terminal count into the idle activity', async () => {
    const getSnapshot = vi.fn().mockReturnValue([])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca',
      getActiveTerminalCount: () => 5,
      throttleIntervalMs: 0
    })

    mgr.start()
    await flush()
    client.setActivity.mockClear()

    subscribeChanges.mock.calls[0][0]()
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.state).toBe('5 terminals open')
  })

  it('stop() unsubscribes and disconnects', async () => {
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
    await flush()
    mgr.stop()

    expect(unsubscribe).toHaveBeenCalled()
    expect(client.disconnect).toHaveBeenCalled()
  })
})