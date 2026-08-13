import { describe, it, expect, vi } from 'vitest'
import { DiscordPresenceManager } from './discord-presence-manager'
import { DiscordHandshakeRejectedError } from './discord-rpc-client'
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
    expect(activity.details).toBe('1 agent active')
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
    expect(activity.details).toBe('1 agent active')
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

  it('does not retry when handshake is rejected (invalid client_id)', async () => {
    const subscribeChanges = vi.fn().mockReturnValue(() => {})
    const client = makeClient()
    client.connect.mockRejectedValue(new DiscordHandshakeRejectedError())

    const mgr = new DiscordPresenceManager({
      getSnapshot: vi.fn().mockReturnValue([]),
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca'
    })

    mgr.start()
    await flush()

    // Connected once, rejected, should NOT schedule reconnect or retry
    expect(client.connect).toHaveBeenCalledTimes(1)

    // Subsequent onChange calls (e.g. from agent state changes) must not trigger a new connect
    const changeCb = subscribeChanges.mock.calls[0][0] as () => void
    changeCb()
    changeCb()
    await flush()

    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('does not start overlapping connect attempts on rapid status changes', async () => {
    const subscribeChanges = vi.fn().mockReturnValue(() => {})
    let connectCount = 0
    const client = {
      connect: vi.fn(() => new Promise<void>((_res) => {
        connectCount++
      })),
      setActivity: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onDisconnect: vi.fn()
    }

    const mgr = new DiscordPresenceManager({
      getSnapshot: vi.fn().mockReturnValue([]),
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca'
    })

    mgr.start()

    // Simulate rapid status changes while connect is in-flight
    const changeCb = subscribeChanges.mock.calls[0][0] as () => void
    changeCb()
    changeCb()
    changeCb()
    await flush()

    // Only one connect attempt should be in flight
    expect(connectCount).toBe(1)
  })

  it('publishes immediately after reconnect (throttle reset on disconnect)', async () => {
    const getSnapshot = vi.fn().mockReturnValue([workingEntry()])
    const subscribeChanges = vi.fn()
    const client = makeClient()

    const mgr = new DiscordPresenceManager({
      getSnapshot,
      subscribeChanges,
      client,
      isEnabled: () => true,
      assetKey: 'orca',
      throttleIntervalMs: 60_000, // long interval so trailing never fires on its own
      reconnectBaseDelayMs: 0
    })

    mgr.start()
    await flush()

    // First publish went through (leading edge)
    expect(client.setActivity).toHaveBeenCalledTimes(1)
    client.setActivity.mockClear()

    // Simulate disconnect — reset() clears lastTime so next publish is a leading edge
    client.onDisconnectCbs.forEach((cb) => cb())
    // flush once for the 0ms reconnect timer, once for the connect() microtask
    await flush()
    await flush()

    // After reconnect, onChange fires again — throttle was reset, so publishes immediately
    expect(client.setActivity).toHaveBeenCalledTimes(1)
    const activity = client.setActivity.mock.calls[0][0] as DiscordActivity
    expect(activity.details).toBe('1 agent active')
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