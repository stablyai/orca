import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./wsl-host-client-instance', () => ({
  wslHostClientInstanceId: () => 'this-installation'
}))

import { ORCAD_DECLARE_CLIENT_METHOD } from '../../shared/orcad-peer-desktops-contract'
import { declareWslHostClient } from './wsl-host-client-declaration'

describe('declareWslHostClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('declares this installation on a WSL host’s control socket', async () => {
    const request = vi.fn(async () => ({
      id: 'x',
      ok: true as const,
      result: {},
      _meta: { runtimeId: 'r' }
    }))
    declareWslHostClient('wsl:ubuntu', request, () => true)
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        ORCAD_DECLARE_CLIENT_METHOD,
        { clientInstanceId: 'this-installation' },
        expect.any(Number)
      )
    )
  })

  it('declares nothing to any other server', () => {
    const request = vi.fn()
    declareWslHostClient('ssh-managed', request, () => false)
    expect(request).not.toHaveBeenCalled()
  })

  it('takes an older server’s missing method quietly', async () => {
    const request = vi.fn(async () => ({
      id: 'x',
      ok: false as const,
      error: { code: 'method_not_found', message: 'nope' },
      _meta: { runtimeId: 'r' }
    }))
    declareWslHostClient('wsl:ubuntu', request, () => true)
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(console.warn).not.toHaveBeenCalled()
  })
})
