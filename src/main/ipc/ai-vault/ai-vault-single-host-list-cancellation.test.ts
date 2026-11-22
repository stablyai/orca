import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeAiVaultScanOptions } from '../../ai-vault/runtime-hosts/ai-vault-runtime-scan'
import { resetLocalAiVaultScanProgressForTests } from '../../ai-vault/scan-lifecycle/ai-vault-local-scan-progress'

vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }))

const { _internals, registerAiVaultHandlers } = await import('./ai-vault')

beforeEach(() => {
  _internals.resetAiVaultCacheForTests()
})

afterEach(resetLocalAiVaultScanProgressForTests)

describe('single Orca server session list cancellation', () => {
  it('aborts the runtime call when the list is cancelled', async () => {
    let scanSignal: AbortSignal | undefined
    const scanner = vi.fn(
      (_environmentId: string, _args: unknown, options?: RuntimeAiVaultScanOptions) => {
        scanSignal = options?.signal
        return new Promise<never>(() => {})
      }
    )
    registerAiVaultHandlers({ scanRuntimeAiVaultSessions: scanner })
    const controller = new AbortController()

    const listed = _internals.listAiVaultSessions(
      { executionHostScope: 'runtime:env-1' },
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(scanSignal).toBeDefined())
    controller.abort()

    await expect(listed).rejects.toMatchObject({ name: 'AbortError' })
    expect(scanSignal?.aborted).toBe(true)
  })
})
