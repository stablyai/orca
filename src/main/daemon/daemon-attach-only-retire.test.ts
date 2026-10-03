import { describe, expect, it, vi } from 'vitest'
import { retireAccidentalAttachOnlySpawn } from './daemon-attach-only-retire'

describe('retireAccidentalAttachOnlySpawn', () => {
  it('reports success when kill resolves', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    await expect(retireAccidentalAttachOnlySpawn({ kill })).resolves.toEqual({ ok: true })
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('reports failure without a second kill attempt', async () => {
    const error = new Error('kill transport lost')
    const kill = vi.fn().mockRejectedValue(error)
    await expect(retireAccidentalAttachOnlySpawn({ kill })).resolves.toEqual({
      ok: false,
      error
    })
    expect(kill).toHaveBeenCalledTimes(1)
  })
})
