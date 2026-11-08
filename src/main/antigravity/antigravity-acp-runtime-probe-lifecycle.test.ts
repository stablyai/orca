import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import type * as AcpConnection from '../acp/acp-agent-connection'
import { PROVIDER_EXIT_OUTPUT_DRAIN_MS } from '../provider-process/provider-exit-output-drain'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

const spawn = vi.hoisted(() => vi.fn<PipedProcessSpawner>())
vi.mock('../acp/acp-agent-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof AcpConnection>()
  return {
    ...actual,
    createAcpAgentConnection: (...args: Parameters<typeof actual.createAcpAgentConnection>) =>
      actual.createAcpAgentConnection(args[0], args[1], spawn)
  }
})
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn(async () => 'unverifiable')
}))

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('bounds the stderr wait when an inherited pipe stays open', async () => {
  vi.useFakeTimers()
  const child = createFakePipedChild(9_999_999)
  spawn.mockReturnValue(child)
  const failure = probeAntigravityAcpServer(
    'fixture-server',
    '1.3.0',
    new AbortController().signal
  ).catch((error: unknown) => error)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  child.emit('exit', 3, null)
  // The exit first waits for stdout to drain, then for stderr; both are bounded.
  await vi.advanceTimersByTimeAsync(2 * PROVIDER_EXIT_OUTPUT_DRAIN_MS)
  await expect(failure).resolves.toMatchObject({ failure: { kind: 'exit', stderr: '' } })
  expect(child.stderr.listenerCount('close')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
