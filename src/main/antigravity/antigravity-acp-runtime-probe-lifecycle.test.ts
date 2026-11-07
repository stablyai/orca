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

it('includes stderr delivered after the process exit', async () => {
  vi.useFakeTimers()
  const child = createFakePipedChild(9_999_999)
  spawn.mockReturnValue(child)
  const failure = probeAntigravityAcpServer(
    'fixture-server',
    '1.3.0',
    new AbortController().signal
  ).catch((error: unknown) => error)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  // Stdout ends with the exit, so only stderr is still arriving when the probe reads it.
  child.stdout.end()
  child.emit('exit', 3, null)
  await vi.advanceTimersByTimeAsync(PROVIDER_EXIT_OUTPUT_DRAIN_MS / 2)
  child.stderr.end('late diagnostic\n')
  await expect(failure).resolves.toMatchObject({
    failure: { kind: 'exit', exit: { code: 3 }, stderr: 'late diagnostic' }
  })
})

it('retains the initialize timeout when teardown cannot prove exit', async () => {
  vi.useFakeTimers()
  spawn.mockReturnValue(createFakePipedChild(9_999_999))
  const failure = probeAntigravityAcpServer(
    'fixture-server',
    '1.3.0',
    new AbortController().signal
  ).catch((error: unknown) => error)
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(70_000)
  await expect(failure).resolves.toMatchObject({
    cause: { message: 'Its exit was not proven after the check' },
    failure: { kind: 'timeout', timeoutMs: 60_000 }
  })
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
