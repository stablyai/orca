import { describe, expect, it, vi } from 'vitest'
import { WslDistroVersion1Error } from './wsl-distro-unsupported'
import { connectForWslHostAdd } from './wsl-host-first-connect'

describe('connectForWslHostAdd', () => {
  it('refuses a WSL 1 distro with the English message and its translation code', async () => {
    const connector = {
      connect: vi.fn().mockRejectedValue(new WslDistroVersion1Error('Ubuntu')),
      disconnect: vi.fn().mockResolvedValue(undefined),
      releaseHolder: vi.fn().mockResolvedValue(undefined)
    }
    await expect(connectForWslHostAdd(connector, 'Ubuntu', () => null)).resolves.toEqual({
      ok: false,
      kind: 'unsupported-wsl1',
      message:
        'Ubuntu runs WSL 1, which Orca no longer supports. Convert it to WSL 2 in a Windows terminal with: wsl --set-version Ubuntu 2',
      errorCode: 'wsl1',
      errorParams: { distro: 'Ubuntu' }
    })
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
  })
})
