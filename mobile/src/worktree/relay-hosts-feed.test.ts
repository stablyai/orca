import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))

import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { relayHostsFeed } from './relay-hosts-feed'

function hostsReply(health: string) {
  return {
    id: 'reply',
    ok: true as const,
    result: { hosts: [{ hostId: 'runtime:vm', label: 'vm', health, relay: 'ready' }] },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function desktop(health: () => string): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockImplementation(async () => hostsReply(health()))
  return session
}

function listCalls(session: FakeSession): number {
  return session.sendRequest.mock.calls.filter(
    ([method]) => method === MOBILE_RELAY_HOSTS_LIST_METHOD
  ).length
}

describe('the desktop’s server list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is read once per poll however many readers share it', async () => {
    const session = desktop(() => 'available')
    const feed = relayHostsFeed(session)
    await feed.read()
    await vi.advanceTimersByTimeAsync(1000)
    const unsubscribe = feed.subscribe(() => {})
    const unsubscribeAgain = feed.subscribe(() => {})
    expect(listCalls(session)).toBe(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(listCalls(session)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listCalls(session)).toBe(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(listCalls(session)).toBe(3)
    unsubscribe()
    unsubscribeAgain()
    await vi.advanceTimersByTimeAsync(9000)
    expect(listCalls(session)).toBe(3)
  })

  it('joins a read already in flight', async () => {
    const session = desktop(() => 'available')
    const feed = relayHostsFeed(session)
    const [first, second] = await Promise.all([feed.read(), feed.read()])
    expect(second).toBe(first)
    expect(listCalls(session)).toBe(1)
    expect(feed.getSnapshot()).toBe(first)
    await feed.read()
    expect(feed.getSnapshot()).toBe(first)
    expect(listCalls(session)).toBe(2)
  })

  it('keeps polling after a read slower than the poll', async () => {
    const session = desktop(() => 'available')
    session.sendRequest.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      return hostsReply('available')
    })
    const unsubscribe = relayHostsFeed(session).subscribe(() => {})
    await vi.advanceTimersByTimeAsync(5000)
    expect(listCalls(session)).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(listCalls(session)).toBe(2)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a reply that lands after a drop and reconnect', async () => {
    const session = desktop(() => 'error')
    let releaseStale: () => void = () => {}
    session.sendRequest.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseStale = resolve
      })
      return hostsReply('available')
    })
    const feed = relayHostsFeed(session)
    const stale = feed.read()
    session.publishState('reconnecting')
    session.publishState('connected')
    expect(await feed.read()).toEqual([expect.objectContaining({ health: 'error' })])
    releaseStale()
    expect(await stale).toBeNull()
    expect(feed.getSnapshot()?.[0]?.health).toBe('error')
  })

  it('forgets its answer on a drop, and reads again on reconnect', async () => {
    let health = 'available'
    const session = desktop(() => health)
    const feed = relayHostsFeed(session)
    const unsubscribe = feed.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getSnapshot()?.[0]?.health).toBe('available')
    session.publishState('reconnecting')
    expect(feed.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(9000)
    expect(listCalls(session)).toBe(1)
    health = 'error'
    session.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getSnapshot()?.[0]?.health).toBe('error')
    unsubscribe()
  })
})
