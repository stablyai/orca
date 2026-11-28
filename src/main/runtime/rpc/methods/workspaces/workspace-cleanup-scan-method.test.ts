import { expect, it, vi } from 'vitest'
import { WORKSPACE_CLEANUP_SCAN_METHOD } from './workspace-cleanup-scan-method'
import { scanWorkspaceCleanup } from '../../../../ipc/workspace-cleanup/workspace-cleanup-scan'

vi.mock('../../../../ipc/workspace-cleanup/workspace-cleanup-scan', () => ({
  scanWorkspaceCleanup: vi.fn()
}))

it('backfills the host PR cache before the scan reads it', async () => {
  const order: string[] = []
  const backfill = vi.fn(async () => {
    order.push('backfill')
  })
  vi.mocked(scanWorkspaceCleanup).mockImplementation(async () => {
    order.push('scan')
    return { scannedAt: 1, candidates: [], errors: [] }
  })
  const signal = new AbortController().signal
  const runtime = {
    hostPRCache: { backfill },
    requireStore: () => ({}),
    getExistingOrchestrationDb: () => null
  }
  await WORKSPACE_CLEANUP_SCAN_METHOD.handler(
    { worktreeIds: ['repo-1::/w'] },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime members.
    { runtime, signal } as unknown as Parameters<typeof WORKSPACE_CLEANUP_SCAN_METHOD.handler>[1]
  )
  expect(backfill).toHaveBeenCalledWith({ wait: true, signal, worktreeIds: ['repo-1::/w'] })
  expect(order).toEqual(['backfill', 'scan'])
})
