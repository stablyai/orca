import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addWslHostEnvironment,
  findWslHostDeployment
} from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { backfillWslHostRegistration } from './wsl-host-connection-record'

const distroId = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'

describe('WSL host registration backfill', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-registration-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  /** A host added by a build that did not capture the registration GUID. */
  function addLegacyHost(): WslHostDeploymentRecord {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'token-1',
        publicKeyB64: Buffer.alloc(32, 7).toString('base64')
      }),
      record: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
    })
    const record = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!record) {
      throw new Error('missing WSL host record')
    }
    return record
  }

  it('records the GUID the registry reports for the distro', async () => {
    const record = addLegacyHost()
    const read = vi.fn(async (_distro: string) => distroId)

    expect(await backfillWslHostRegistration(userDataPath, record, read)).toBe(true)
    expect(read).toHaveBeenCalledWith('Ubuntu')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.distroId).toBe(distroId)
  })

  // Why: without the GUID the browser identity fails closed, so a failed read must change nothing.
  const failedReads: { label: string; read: (distro: string) => Promise<string | null> }[] = [
    { label: 'unreadable', read: async () => null },
    {
      label: 'failing',
      read: async () => {
        throw new Error('reg.exe failed')
      }
    }
  ]
  it.each(failedReads)('leaves the GUID absent when the registry is $label', async ({ read }) => {
    const record = addLegacyHost()

    expect(await backfillWslHostRegistration(userDataPath, record, read)).toBe(false)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.distroId).toBeUndefined()
  })

  it('never reads the registry for a host that already has its GUID', async () => {
    const record = { ...addLegacyHost(), distroId }
    const read = vi.fn(async (_distro: string) => distroId)

    expect(await backfillWslHostRegistration(userDataPath, record, read)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
})
