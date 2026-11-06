import { afterEach, expect, it, vi } from 'vitest'
import { createBridgePortPair } from './bridge-port-pair-test-harness'
import { stubRpcClient } from '../../transport/rpc-client-test-stub'
import { RpcClientRequestTracker } from '../../transport/rpc-client-request-tracker'

afterEach(() => vi.useRealTimers())

it('carries a launch total allowance from the page to the phone request tracker', async () => {
  vi.useFakeTimers()
  const tracker = new RpcClientRequestTracker({
    nextId: () => 'rpc-launch',
    getState: () => 'connected',
    waitForConnected: async () => {},
    sendFrame: () => true
  })
  const rpc = stubRpcClient({ sendRequest: (m, p, o) => tracker.sendRequest(m, p, o) })
  const pair = createBridgePortPair({ rpc, sessionId: 'keepalive', buildId: 'keepalive' })
  for (let i = 0; i < 4; i++) {
    pair.drainNow()
  }
  const start = Date.now()
  let settledAt: number | null = null
  const launch = pair.client.sendRequest(
    'agent.launch',
    {
      agent: 'codex',
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:repo-1', name: 'kestrel', clientMutationId: 'mutation-1' }
      }
    },
    { timeoutMs: 600_000, keepaliveTotalMs: 1_200_000 }
  )
  void launch.catch(() => {
    settledAt = Date.now() - start
  })
  await pair.flush()
  // The host still serving the launch renews its idle timeout past the ordinary 10 minutes.
  await vi.advanceTimersByTimeAsync(540_000)
  tracker.keepalive('rpc-launch')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(settledAt).toBeNull()
  // Keepalives never carry it past its total.
  for (let at = 600_000; at < 1_200_000; at += 300_000) {
    tracker.keepalive('rpc-launch')
    await vi.advanceTimersByTimeAsync(300_000)
  }
  await pair.flush()
  expect(settledAt).toBe(1_200_000)
})
