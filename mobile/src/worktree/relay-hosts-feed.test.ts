import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))

import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
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

describe('the desktop’s server list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
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

  it('reads again when the desktop says its hosts changed, instead of every few seconds', async () => {
    let emit: (event: unknown) => void = () => {}
    let reads = 0
    const client = stubRpcClient({
      getLastConnectedAt: () => 1,
      subscribe: (_method, _params, onData) => {
        emit = onData
        return () => {}
      },
      sendRequest: async () => {
        reads += 1
        return hostsReply('available')
      }
    })
    relayHostsFeed(client).subscribe(() => {}, true)
    emit({ type: 'ready', subscriptionId: 'events-1' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads).toBe(2)

    emit({ type: 'relayHostsChanged' })
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toBe(3)

    // The backstop still asks the desktop, in case a notice was lost.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toBe(4)
  })
})
