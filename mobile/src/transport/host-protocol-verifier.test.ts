import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { HostProtocolAdmission } from './host-protocol-admission'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import {
  attachHostProtocolVerification,
  HOST_STATUS_REQUEST_TIMEOUT_MS
} from './host-protocol-verifier'

const compatible = { protocolVersion: 3, minCompatibleMobileVersion: 3 }

function sessionAnswering(result: unknown = compatible): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockResolvedValue({ id: '1', ok: true, result })
  return session
}

function verifiedClient(session: FakeSession) {
  return attachHostProtocolVerification(
    createStableLogicalRpcClient(session, 'lan', new HostProtocolAdmission()),
    'host-1'
  )
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('host protocol verifier', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Why (F1): admission gates every screen, but the only gate component mounts under /h/.
  // A client opened for the launch screen has to verify itself with nothing rendered.
  it('opens admission with no route mounted, so home subscriptions and RPCs go through', async () => {
    const session = sessionAnswering()
    const client = verifiedClient(session)
    await settle()

    client.subscribe('notifications.subscribe', {}, () => {})
    client.subscribe('accounts.subscribe', null, () => {})
    await expect(client.sendRequest('worktree.ps', { limit: 200 })).resolves.toMatchObject({
      ok: true
    })
    expect(session.subscribe.mock.calls.map(([method]) => method)).toEqual([
      'notifications.subscribe',
      'accounts.subscribe'
    ])
    expect(client.getVerification()).toMatchObject({ verdict: { kind: 'ok' }, pending: false })
    client.close()
  })

  // Why (F2): migrateTo resets admission and replays subscriptions through a closed gate.
  it('re-verifies after a cutover, reattaching subscriptions with no route mounted', async () => {
    const session = sessionAnswering()
    const client = verifiedClient(session)
    await settle()
    client.subscribe('notifications.subscribe', {}, () => {})

    const replacement = sessionAnswering()
    await client.migrateTo(replacement, 'relay')
    await settle()

    expect(replacement.subscribe.mock.calls.map(([method]) => method)).toEqual([
      'notifications.subscribe'
    ])
    await expect(client.sendRequest('worktree.ps')).resolves.toMatchObject({ ok: true })
    expect(client.getVerification()).toMatchObject({ generation: 2, verdict: { kind: 'ok' } })
    client.close()
  })

  it('probes once the client reaches connected, not before', async () => {
    const session = sessionAnswering()
    session.publishState('connecting')
    const client = verifiedClient(session)
    await settle()
    expect(session.sendRequest).not.toHaveBeenCalled()
    expect(client.getVerification()).toMatchObject({ pending: true })

    session.publishState('connected')
    await settle()
    expect(session.sendRequest).toHaveBeenCalledOnce()
    expect(client.getVerification()).toMatchObject({ verdict: { kind: 'ok' } })
    client.close()
  })

  // Why (F4): timeoutMs alone budgets only the post-connect wait, so the attempt can take
  // twice as long as the ceiling the retry schedule is written against.
  it('spends the status timeout on the whole attempt, connect wait included', async () => {
    const session = sessionAnswering()
    const client = verifiedClient(session)
    await settle()

    expect(session.sendRequest).toHaveBeenCalledWith('status.get', undefined, {
      timeoutMs: HOST_STATUS_REQUEST_TIMEOUT_MS,
      budgetSpansConnect: true
    })
    client.close()
  })

  // Why (F3): a cutover blip on a host that already answered must not bury a live screen
  // under a modal error card; it stays pending while the bounded retries run.
  it('keeps a proven host pending through its retries and settles when they run out', async () => {
    vi.useFakeTimers()
    const session = sessionAnswering()
    const client = verifiedClient(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getVerification()).toMatchObject({ verdict: { kind: 'ok' } })

    const replacement = new FakeSession('connected')
    replacement.sendRequest.mockRejectedValue(new Error('offline'))
    await client.migrateTo(replacement, 'relay')
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getVerification()).toMatchObject({
      generation: 2,
      verdict: { kind: 'unknown' },
      pending: true
    })

    for (const delay of [1_000, 2_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(replacement.sendRequest).toHaveBeenCalledTimes(4)
    expect(client.getVerification()).toMatchObject({ pending: false })
    client.close()
  })

  it('settles a never-verified host on its first refusal so recovery is offered at once', async () => {
    vi.useFakeTimers()
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'unavailable', message: 'offline' }
    })
    const client = verifiedClient(session)
    await vi.advanceTimersByTimeAsync(0)

    expect(client.getVerification()).toMatchObject({ verdict: { kind: 'unknown' }, pending: false })
    client.retryVerification()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.sendRequest).toHaveBeenCalledTimes(2)
    client.close()
  })

  it('stops probing once the client is closed', async () => {
    vi.useFakeTimers()
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValue(new Error('offline'))
    const client = verifiedClient(session)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.sendRequest).toHaveBeenCalledOnce()

    client.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(session.sendRequest).toHaveBeenCalledOnce()
  })
})
