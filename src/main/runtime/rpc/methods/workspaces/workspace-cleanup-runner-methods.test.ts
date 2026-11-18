import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RuntimeSubscriptionRegistry } from '../../../client/runtime-subscription-registry'
import type { RpcContext } from '../../core'
import { WORKSPACE_CLEANUP_RUNNER_METHODS } from './workspace-cleanup-runner-methods'

const walks = vi.hoisted(() => {
  const started: { signal: AbortSignal; finish: () => void }[] = []
  return started
})

vi.mock('../../../../codex/history/disk-usage/codex-history-disk-usage', async () => {
  const { createCodexHistoryDiskUsageReader } =
    await import('../../../../codex/history/disk-usage/codex-history-disk-usage-reader')
  const reader = createCodexHistoryDiskUsageReader(0)
  return {
    getCodexHistoryDiskUsage: (_settings: unknown, consumer?: string) =>
      reader.read(
        (signal) =>
          new Promise((resolve, reject) => {
            walks.push({ signal, finish: () => resolve({ bytes: 7, rollouts: 1, complete: true }) })
            signal.addEventListener('abort', () => reject(new Error('stopped')))
          }),
        consumer
      ),
    releaseCodexHistoryDiskUsage: (consumer: string) => reader.release(consumer)
  }
})

const registry = new RuntimeSubscriptionRegistry()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the size read uses only these two runtime members.
const runtime = {
  requireStore: () => ({ getSettings: () => ({}) }),
  registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry)
} as unknown as OrcaRuntimeService

const readSize = WORKSPACE_CLEANUP_RUNNER_METHODS.find(
  (method) => method.name === 'workspaceCleanup.codexHistoryDiskUsage'
)!

function read(connectionId: string, consumerId: string): Promise<unknown> {
  const ctx: RpcContext = { runtime, connectionId }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: find() widens the handler to every method's params; this one takes { consumerId }.
  return Promise.resolve(readSize.handler({ consumerId } as never, ctx))
}

describe('workspaceCleanup.codexHistoryDiskUsage', () => {
  it('stops the walk when the last connection waiting for it closes without releasing', async () => {
    const closed = read('window-a', 'view').catch((error: Error) => error.message)
    const surviving = read('window-b', 'view')
    await vi.waitFor(() => expect(walks).toHaveLength(1))

    registry.cleanupForConnection('window-a')
    expect(walks[0].signal.aborted).toBe(false)
    walks[0].finish()
    await expect(surviving).resolves.toEqual({ bytes: 7, rollouts: 1, complete: true })
    await closed

    const abandoned = read('window-c', 'view').catch((error: Error) => error.message)
    await vi.waitFor(() => expect(walks).toHaveLength(2))
    registry.cleanupForConnection('window-c')
    expect(walks[1].signal.aborted).toBe(true)
    await expect(abandoned).resolves.toBe('stopped')
  })
})
