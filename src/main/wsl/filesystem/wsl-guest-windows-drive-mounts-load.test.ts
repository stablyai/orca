import { afterEach, describe, expect, it, vi } from 'vitest'

const readFile = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', () => ({ readFile, access: vi.fn(async () => undefined) }))

import { ORCAD_WSL_HOST_ENV } from '../../../shared/remote-runtime/serve-supervisor/orcad-server-launch-env'
import {
  _setGuestWindowsDriveMountsForTests,
  loadGuestWindowsDriveMounts,
  readGuestWindowsDriveMounts
} from './wsl-guest-windows-drive-path'

const platform = process.platform

afterEach(() => {
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { value: platform })
  readFile.mockReset()
  _setGuestWindowsDriveMountsForTests(null)
})

describe('the guest Windows drive mounts', () => {
  it('are read once, asynchronously, and then served to sync readers', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.stubEnv(ORCAD_WSL_HOST_ENV, '1')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    readFile.mockResolvedValue('C:\\134 /mnt/c 9p rw 0 0\nnone / ext4 rw 0 0\n')
    expect(readGuestWindowsDriveMounts()).toEqual([])
    await expect(loadGuestWindowsDriveMounts()).resolves.toEqual(['/mnt/c'])
    await loadGuestWindowsDriveMounts()
    expect(readGuestWindowsDriveMounts()).toEqual(['/mnt/c'])
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('are none outside a WSL-host orcad, without reading', async () => {
    vi.stubEnv(ORCAD_WSL_HOST_ENV, '')
    await expect(loadGuestWindowsDriveMounts()).resolves.toEqual([])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('are none when /proc/mounts is unreadable', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.stubEnv(ORCAD_WSL_HOST_ENV, '1')
    vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
    readFile.mockRejectedValue(new Error('EACCES'))
    await expect(loadGuestWindowsDriveMounts()).resolves.toEqual([])
  })
})
