import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeEnvironment = vi.hoisted(() => vi.fn())
vi.mock('../../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))

import { callRuntimeSessionSearch } from './runtime-session-search-call'

beforeEach(() => {
  callRuntimeEnvironment.mockReset()
})

describe('runtime session search transport', () => {
  it('rethrows a refusal with its code so an old host reads as an absent method', async () => {
    callRuntimeEnvironment.mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'method_not_found', message: 'unknown method' }
    })
    await expect(
      callRuntimeSessionSearch('/user/data', 'env-1', 'aiVault.searchSessions', {})
    ).rejects.toMatchObject({ code: 'method_not_found', message: 'unknown method' })
  })
})
