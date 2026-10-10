import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAwakeStatus } from '../agent-awake-status-lease'
import type { DiscordActivity, DiscordIpcConnection } from './discord-ipc-client'
import {
  DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS,
  DISCORD_PRESENCE_RETRY_INTERVAL_MS,
  DiscordPresenceService
} from './discord-presence-service'

const translate = (_key: string, fallback: string, options?: { count: number }): string =>
  options ? fallback.replace('{{count}}', String(options.count)) : fallback

type FakeConnection = DiscordIpcConnection & {
  activities: (DiscordActivity | null)[]
  closed: boolean
  dropFromDiscord: () => void
}

function status(paneKey: string, state: AgentAwakeStatus['state']): AgentAwakeStatus {
  return { paneKey, state, receivedAt: Date.now(), observedInCurrentRuntime: true }
}

function createHarness() {
  const connections: FakeConnection[] = []
  const pending: {
    resolve: (connection: FakeConnection) => void
    reject: (error: Error) => void
    onClosed: () => void
  }[] = []
  const connect = vi.fn(
    ({ onClosed }: { onClosed: () => void }) =>
      new Promise<DiscordIpcConnection>((resolve, reject) => {
        pending.push({ resolve, reject, onClosed })
      })
  )
  const service = new DiscordPresenceService({
    connect,
    translate,
    logger: { debug: vi.fn() }
  })
  const acceptNext = async (): Promise<FakeConnection> => {
    const request = pending.shift()
    if (!request) {
      throw new Error('no pending connect')
    }
    const connection: FakeConnection = {
      activities: [],
      closed: false,
      setActivity: (activity) => connection.activities.push(activity),
      close: () => {
        connection.closed = true
      },
      dropFromDiscord: request.onClosed
    }
    connections.push(connection)
    request.resolve(connection)
    await vi.advanceTimersByTimeAsync(0)
    return connection
  }
  const rejectNext = async (): Promise<void> => {
    pending.shift()?.reject(new Error('ENOENT'))
    await vi.advanceTimersByTimeAsync(0)
  }
  return { service, connect, acceptNext, rejectNext, connections }
}

describe('DiscordPresenceService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays off and never connects until enabled', () => {
    const { service, connect } = createHarness()
    service.setStatuses([status('a', 'working')])
    expect(connect).not.toHaveBeenCalled()
    expect(service.getStatus()).toBe('off')
  })

  it('publishes the current agent counts once connected', async () => {
    const { service, acceptNext } = createHarness()
    service.setStatuses([status('a', 'working'), status('b', 'working'), status('c', 'blocked')])
    service.setEnabled(true)
    expect(service.getStatus()).toBe('connecting')

    const connection = await acceptNext()
    expect(service.getStatus()).toBe('connected')
    expect(connection.activities).toHaveLength(1)
    expect(connection.activities[0]).toMatchObject({
      details: 'Running 2 agents',
      state: '1 agent waiting for input',
      timestamps: { start: 1_000_000 }
    })
  })

  it('ignores rows replayed from a previous runtime', async () => {
    const { service, acceptNext } = createHarness()
    service.setStatuses([{ ...status('a', 'working'), observedInCurrentRuntime: false }])
    service.setEnabled(true)
    const connection = await acceptNext()
    expect(connection.activities[0]?.details).toBe('Idle')
  })

  it('coalesces bursts into one update per rate-limit window', async () => {
    const { service, acceptNext } = createHarness()
    service.setEnabled(true)
    const connection = await acceptNext()
    expect(connection.activities).toHaveLength(1)

    service.setStatuses([status('a', 'working')])
    service.setStatuses([status('a', 'working'), status('b', 'working')])
    service.setStatuses([status('a', 'working'), status('b', 'working'), status('c', 'working')])
    expect(connection.activities).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS)
    expect(connection.activities).toHaveLength(2)
    expect(connection.activities[1]?.details).toBe('Running 3 agents')
  })

  it('skips sending an unchanged activity', async () => {
    const { service, acceptNext } = createHarness()
    service.setEnabled(true)
    const connection = await acceptNext()
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS)
    service.setStatuses([status('a', 'done')])
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_MIN_UPDATE_INTERVAL_MS)
    expect(connection.activities).toHaveLength(1)
  })

  it('retries on an interval while Discord is not running', async () => {
    const { service, connect, rejectNext, acceptNext } = createHarness()
    service.setEnabled(true)
    await rejectNext()
    expect(service.getStatus()).toBe('unavailable')
    expect(connect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_RETRY_INTERVAL_MS)
    expect(connect).toHaveBeenCalledTimes(2)
    await acceptNext()
    expect(service.getStatus()).toBe('connected')
  })

  it('reconnects after Discord closes the connection', async () => {
    const { service, connect, acceptNext } = createHarness()
    service.setEnabled(true)
    const first = await acceptNext()
    first.dropFromDiscord()
    expect(service.getStatus()).toBe('unavailable')

    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_RETRY_INTERVAL_MS)
    expect(connect).toHaveBeenCalledTimes(2)
    const second = await acceptNext()
    expect(second.activities).toHaveLength(1)
  })

  it('clears presence and closes when disabled', async () => {
    const { service, connect, acceptNext } = createHarness()
    service.setEnabled(true)
    const connection = await acceptNext()
    service.setEnabled(false)

    expect(connection.activities.at(-1)).toBeNull()
    expect(connection.closed).toBe(true)
    expect(service.getStatus()).toBe('off')
    await vi.advanceTimersByTimeAsync(DISCORD_PRESENCE_RETRY_INTERVAL_MS * 2)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('closes a connection that completes after presence was turned off', async () => {
    const { service, acceptNext } = createHarness()
    service.setEnabled(true)
    service.setEnabled(false)
    const late = await acceptNext()
    expect(late.closed).toBe(true)
    expect(late.activities).toHaveLength(0)
    expect(service.getStatus()).toBe('off')
  })

  it('notifies subscribers of status transitions', async () => {
    const { service, acceptNext } = createHarness()
    const seen: string[] = []
    service.subscribe((next) => seen.push(next))
    service.setEnabled(true)
    await acceptNext()
    service.setEnabled(false)
    expect(seen).toEqual(['connecting', 'connected', 'off'])
  })
})
