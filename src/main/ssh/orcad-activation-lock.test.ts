import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue(''),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error && 'sshChannelCloseConfirmed' in error
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from './orcad-activation-lock'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const options = {
  conn: {} as SshConnection,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/orca'
}

describe('orcad activation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('holds one host-wide lock through the transaction and releases it afterward', async () => {
    const run = vi.fn(async () => 'done')
    await expect(withOrcadActivationLock(options, run)).resolves.toBe('done')

    expect(acquireInstallLock).toHaveBeenCalledWith(
      options.conn,
      '/home/orca/.orca-remote/.orcad-activation-transaction',
      options.host,
      { signal: undefined, allowStaleTakeover: false }
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(execCommand).mock.calls[0]?.[1])).toContain(
      '.orcad-activation-transaction'
    )
  })

  it('keeps the lock when remote mutation teardown is unconfirmed', async () => {
    const error = Object.assign(new Error('transport lost'), {
      sshChannelCloseConfirmed: false
    })

    await expect(
      withOrcadActivationLock(options, async () => {
        throw error
      })
    ).rejects.toBe(error)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('releases the lock after a confirmed transaction failure', async () => {
    await expect(
      withOrcadActivationLock(options, async () => {
        throw new Error('rejected')
      })
    ).rejects.toThrow('rejected')
    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('keeps the lock after a transaction crosses its remote-mutation boundary', async () => {
    const error = new Error('readiness polling aborted')

    await expect(
      withOrcadActivationLock(options, async (control) => {
        control.retainOnError()
        throw error
      })
    ).rejects.toBe(error)

    expect(execCommand).not.toHaveBeenCalled()
  })

  it('keeps the lock after a returned result leaves remote state unresolved', async () => {
    await expect(
      withOrcadActivationLock(options, async (control) => {
        control.retain()
        return 'recovery-required'
      })
    ).resolves.toBe('recovery-required')

    expect(execCommand).not.toHaveBeenCalled()
  })

  it('surfaces a successful transaction whose lock release failed', async () => {
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce('')

    await expect(withOrcadActivationLock(options, async () => 'done')).rejects.toThrow(
      'release failed'
    )
    expect(execCommand).toHaveBeenCalledTimes(2)
  })

  it('does not retry an unconfirmed lock release', async () => {
    const error = Object.assign(new Error('transport lost'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(execCommand).mockRejectedValueOnce(error)

    await expect(withOrcadActivationLock(options, async () => 'done')).rejects.toBe(error)
    expect(execCommand).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1.5, Number.NaN, 300_001])('rejects invalid readiness timeout %s', (timeout) => {
    expect(() => resolveOrcadActivationReadinessTimeout(timeout, 90_000)).toThrow(
      'orcad readiness timeout'
    )
  })

  it('uses and validates the fallback readiness timeout', () => {
    expect(resolveOrcadActivationReadinessTimeout(undefined, 90_000)).toBe(90_000)
    expect(() => resolveOrcadActivationReadinessTimeout(undefined, 0)).toThrow(
      'orcad readiness timeout'
    )
  })
})
