import { describe, expect, it } from 'vitest'
import { runCloudDelivery, type CloudDeliveryDeps } from './cloud-delivery-run'
import type { QueuedCloudPrompt } from './cloud-prompt-queue'

function prompt(id: string, status: QueuedCloudPrompt['status'] = 'queued'): QueuedCloudPrompt {
  return {
    id,
    sandboxId: 'sbx_1',
    text: `prompt ${id}`,
    agent: 'claude',
    operationId: `op-${id}`,
    status,
    createdAt: 1
  }
}

/** An in-memory queue with the real delivery rules: failed prompts are skipped, not retried. */
function fakeQueue(initial: QueuedCloudPrompt[], overrides: Partial<CloudDeliveryDeps> = {}) {
  let queue = [...initial]
  const launched: string[] = []
  const deps: CloudDeliveryDeps = {
    listQueued: async () => queue,
    ensureWorktree: async () => 'wt-1',
    launch: async (_worktreeId, entry) => {
      launched.push(entry.id)
      return { agent: entry.agent }
    },
    deliverQueued: async (_sandboxId, deliver, errorCodeFor) => {
      let delivered = 0
      const failed: QueuedCloudPrompt[] = []
      for (const entry of queue.filter((item) => item.status !== 'failed')) {
        try {
          await deliver(entry)
          queue = queue.filter((item) => item.id !== entry.id)
          delivered += 1
        } catch (error) {
          const code = errorCodeFor(error)
          queue = queue.map((item) =>
            item.id === entry.id ? { ...item, status: 'failed' as const, error: code } : item
          )
          failed.push({ ...entry, status: 'failed', error: code })
        }
      }
      return { delivered, failed }
    },
    markWaitingFailed: async (_sandboxId, code) => {
      queue = queue.map((item) =>
        item.status === 'queued' ? { ...item, status: 'failed' as const, error: code } : item
      )
    },
    errorCodeFor: (error) => (error instanceof Error ? error.message : 'launch_failed'),
    ...overrides
  }
  return { deps, launched, queue: () => queue }
}

describe('runCloudDelivery', () => {
  it('opens when nothing is waiting, including when only failed prompts are left', async () => {
    const empty = fakeQueue([])
    expect(await runCloudDelivery('sbx_1', 'open', empty.deps)).toEqual({ kind: 'open' })
    const onlyFailed = fakeQueue([prompt('a', 'failed')])
    expect(await runCloudDelivery('sbx_1', 'open', onlyFailed.deps)).toEqual({ kind: 'open' })
    expect(onlyFailed.launched).toEqual([])
  })

  it('reports the last launched agent after a delivery', async () => {
    const run = fakeQueue([prompt('a'), prompt('b')])
    expect(await runCloudDelivery('sbx_1', 'send', run.deps)).toEqual({
      kind: 'launched',
      worktreeId: 'wt-1',
      agent: { agent: 'claude' }
    })
    expect(run.launched).toEqual(['a', 'b'])
  })

  it('a prompt that does not start still opens the workspace when the user asked to open it', async () => {
    const run = fakeQueue([prompt('a')], {
      launch: async () => {
        throw new Error('launch_failed')
      }
    })
    expect(await runCloudDelivery('sbx_1', 'open', run.deps)).toEqual({
      kind: 'failed',
      code: null,
      open: true
    })
    expect(run.queue()[0]).toMatchObject({ status: 'failed', error: 'launch_failed' })
  })

  it('a failure before any launch marks every waiting prompt failed, so the next Open goes straight in', async () => {
    const run = fakeQueue([prompt('a'), prompt('b')], {
      ensureWorktree: async () => {
        throw new Error('cloud_project_unavailable')
      }
    })
    expect(await runCloudDelivery('sbx_1', 'send', run.deps)).toEqual({
      kind: 'failed',
      code: 'cloud_project_unavailable',
      open: false
    })
    expect(run.queue().map((entry) => entry.status)).toEqual(['failed', 'failed'])
    // The stuck-prompt bug: Open used to re-run this delivery and fail again forever.
    expect(await runCloudDelivery('sbx_1', 'open', run.deps)).toEqual({ kind: 'open' })
  })
})
