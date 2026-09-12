import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))

import { execCommand } from './ssh-relay-deploy-helpers'
import { cleanupRemoteInstallGcTombstones } from './remote-install-gc-tombstone'
import { ORCAD_INSTALL_MODEL, RELAY_INSTALL_MODEL } from './remote-install-model'
import type { SshConnection } from './ssh-connection'

describe('remote install GC tombstones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    [RELAY_INSTALL_MODEL, 'relay', 'orcad'],
    [ORCAD_INSTALL_MODEL, 'orcad', 'relay']
  ])('cleans only strict $model.id tombstones', async (model, ownPrefix, siblingPrefix) => {
    await cleanupRemoteInstallGcTombstones({} as SshConnection, model, '/home/u/.orca-remote', [
      `${ownPrefix}-0.1.0+abc.gc-tombstone.123.456`,
      `${siblingPrefix}-0.1.0+abc.gc-tombstone.123.456`,
      `${ownPrefix}-0.1.0+abc.gc-tombstone.bad.456`,
      `${ownPrefix}-0.1.0+abc`
    ])

    expect(vi.mocked(execCommand)).toHaveBeenCalledOnce()
    expect(String(vi.mocked(execCommand).mock.calls[0]?.[1])).toContain(
      `${ownPrefix}-0.1.0+abc.gc-tombstone.123.456`
    )
  })
})
