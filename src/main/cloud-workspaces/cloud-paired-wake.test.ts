import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => undefined)
}))

import { noteCloudPairingBindings } from './cloud-paired-environment-ids'
import { wakePairedSandbox } from './cloud-paired-wake'

afterEach(() => {
  noteCloudPairingBindings({})
})

describe('wakePairedSandbox (PAIRED-WAKE)', () => {
  it('wakes the sandbox, then reconnects only the server bound to it', async () => {
    noteCloudPairingBindings({
      sbx_gh: { environmentId: 'env-gh' },
      sbx_other: { environmentId: 'env-other' }
    })
    const invalidate = vi.fn(async () => undefined)
    const wake = vi.fn(async () => ({ ok: true as const, value: undefined }))
    expect(await wakePairedSandbox({ wake }, 'sbx_gh', invalidate)).toEqual({
      ok: true,
      value: undefined
    })
    expect(wake).toHaveBeenCalledWith('sbx_gh')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith('env-gh')
  })

  it('a refused wake (billing cap) is passed back untouched, and nothing reconnects', async () => {
    noteCloudPairingBindings({ sbx_gh: { environmentId: 'env-gh' } })
    const invalidate = vi.fn(async () => undefined)
    const refused = { ok: false as const, error: 'Sandbox hours used up', reason: 'quota' }
    expect(await wakePairedSandbox({ wake: async () => refused }, 'sbx_gh', invalidate)).toBe(
      refused
    )
    expect(invalidate).not.toHaveBeenCalled()
  })
})
