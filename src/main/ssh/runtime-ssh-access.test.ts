import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import { prepareRuntimeEnvironmentReconciliation } from '../../shared/runtime-environment-reconciliation-store'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  infrastructure: vi.fn(),
  connect: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  ensure: vi.fn(),
  verify: vi.fn(),
  flush: vi.fn(),
  preflight: vi.fn(),
  hasDirectAuthority: vi.fn()
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadInfrastructure: mocks.infrastructure
}))
vi.mock('./orcad-managed-tunnel', () => ({
  startOrcadManagedTunnel: mocks.start,
  closeOrcadManagedTunnel: mocks.close,
  ensureOrcadManagedTunnel: mocks.ensure
}))
vi.mock('./runtime-ssh-access-verification', () => ({
  verifyRuntimeEnvironmentSshTunnel: mocks.verify
}))
vi.mock('./ssh-target-registry', () => ({
  hasRegisteredDirectSshAuthority: mocks.hasDirectAuthority
}))
import {
  fingerprintRuntimeSshTarget,
  linkRuntimeSshAccess,
  unlinkRuntimeSshAccess
} from './runtime-ssh-access'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://example.test/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'secret',
  pairedDeviceId: 'client'
}

describe('independent runtime SSH access coordinator', () => {
  it.each(['link', 'unlink'])(
    'refuses %s before side effects during host reconciliation',
    async (operation) => {
      const peer = addEnvironmentFromPairingCode(userDataPath, {
        name: 'Other access',
        pairingCode: encodePairingOffer(pairing)
      })
      prepareRuntimeEnvironmentReconciliation(userDataPath, {
        requestId: 'reconciliation',
        canonicalEnvironmentId: environmentId,
        verifiedRuntimeId: 'host-runtime',
        expectedRegistrations: [current(), peer]
      })
      await expect(
        operation === 'link' ? linkRuntimeSshAccess(userDataPath, request()) : unlink()
      ).rejects.toThrow('reconciliation')
      expect(mocks.connect).not.toHaveBeenCalled()
      expect(mocks.start).not.toHaveBeenCalled()
      expect(mocks.close).not.toHaveBeenCalled()
      expect(mocks.flush).not.toHaveBeenCalled()
    }
  )
  let userDataPath: string
  let environmentId: string
  let target: SshTarget
  let events: string[]
  let cutovers: unknown[]
  const request = () => ({
    selector: environmentId,
    requestId: 'request',
    sshTargetId: 'target',
    remotePort: 6768
  })
  const current = () => resolveEnvironment(userDataPath, environmentId)
  const unlink = (requestId = 'unlink') =>
    unlinkRuntimeSshAccess(
      userDataPath,
      { selector: environmentId, requestId },
      {
        invalidateTransport: () => {
          events.push('invalidate')
          expect(current().sshAccess).toBeUndefined()
        }
      }
    )
  beforeEach(() => {
    vi.resetAllMocks()
    events = []
    cutovers = []
    userDataPath = mkdtempSync(join(tmpdir(), 'runtime-access-test-'))
    environmentId = addEnvironmentFromPairingCode(userDataPath, {
      name: 'server',
      pairingCode: encodePairingOffer(pairing)
    }).id
    target = {
      id: 'target',
      label: 'host',
      host: 'host.example',
      port: 22,
      username: 'user',
      source: 'manual',
      generation: 3
    }
    mocks.preflight.mockReturnValue({ blockers: [] })
    mocks.flush.mockImplementation(async () => {
      expect(current().pendingSshAccessOperation).toBeDefined()
      events.push('flush')
    })
    mocks.infrastructure.mockReturnValue({
      connectionManager: { connect: mocks.connect },
      targetStore: {
        getTarget: () => target,
        preflightOrcadRuntimeTarget: mocks.preflight,
        getOrcadMigrationStore: () => ({
          flushPendingOrThrowAsync: mocks.flush,
          listOrcadMigrationSourceCutovers: () => cutovers
        }),
        claimOrcadRuntimeTarget: () => {
          expect(current().pendingSshAccessOperation?.operation).toBe('link')
          events.push('claim')
          target = { ...target, owner: createManagedOrcadSshOwner(environmentId) }
          return target
        },
        releaseOrcadRuntimeTarget: () => {
          expect(current().pendingSshAccessOperation?.operation).toBe('unlink')
          events.push('release')
          target = { ...target, owner: undefined }
          return target
        }
      }
    })
    mocks.connect.mockImplementation(async () => {
      events.push('connect')
      return {}
    })
    mocks.start.mockImplementation(async () => {
      events.push('tunnel')
      return 41000
    })
    mocks.close.mockImplementation(async () => {
      events.push('close')
    })
    mocks.verify.mockImplementation(async () => {
      events.push('verify')
      return {
        verifiedRuntimeId: 'runtime',
        verifiedPairing: { ...pairing, endpoint: 'ws://127.0.0.1:41000' },
        runtimeStatus: {}
      }
    })
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('persists intent then claim before connecting and publishes redacted authenticated access', async () => {
    const result = await linkRuntimeSshAccess(userDataPath, request())
    expect(events).toEqual(['flush', 'claim', 'flush', 'connect', 'tunnel', 'verify'])
    expect(result.sshAccess?.sshTargetId).toBe('target')
    expect(result.orcadDeployment).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(current().pendingSshAccessOperation).toBeUndefined()
    expect(mocks.preflight).toHaveBeenCalledWith('target')
  })

  it('handles lost link responses without connecting or verifying again', async () => {
    const first = await linkRuntimeSshAccess(userDataPath, request())
    expect(await linkRuntimeSshAccess(userDataPath, request())).toEqual(first)
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(mocks.ensure).toHaveBeenCalledWith(userDataPath, environmentId)
  })

  it('invalidates old transport only after authenticated access is published', async () => {
    const invalidateTransport = vi.fn(() => {
      expect(current().sshAccess).toBeDefined()
      expect(current().pendingSshAccessOperation).toBeUndefined()
    })
    await linkRuntimeSshAccess(userDataPath, request(), { invalidateTransport })
    await linkRuntimeSshAccess(userDataPath, request(), { invalidateTransport })
    expect(invalidateTransport).toHaveBeenCalledTimes(2)
  })

  it('rejects changed request tuple after a completed link', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    await expect(
      linkRuntimeSshAccess(userDataPath, { ...request(), remotePort: 6769 })
    ).rejects.toThrow('different')
    expect(mocks.verify).toHaveBeenCalledTimes(1)
  })

  it('preserves the committed tunnel when transport refresh fails and retries the same link', async () => {
    const invalidateTransport = vi.fn().mockRejectedValueOnce(new Error('refresh failed'))
    await expect(
      linkRuntimeSshAccess(userDataPath, request(), { invalidateTransport })
    ).rejects.toThrow('refresh failed')
    const committed = current()
    expect(committed.sshAccess?.requestId).toBe('request')
    expect(committed.pendingSshAccessOperation).toBeUndefined()
    expect(target.owner).toEqual(createManagedOrcadSshOwner(environmentId))
    expect(mocks.close).not.toHaveBeenCalled()

    await linkRuntimeSshAccess(userDataPath, request(), { invalidateTransport })
    expect(current()).toEqual(committed)
    expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith(userDataPath, environmentId)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(invalidateTransport).toHaveBeenCalledTimes(2)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('fences connection configuration changes before opening a forward', async () => {
    mocks.connect.mockImplementationOnce(async () => {
      target = { ...target, username: 'other' }
      return {}
    })
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('changed')
    expect(mocks.start).not.toHaveBeenCalled()
    expect(current().pendingSshAccessOperation?.operation).toBe('link')
  })

  it('restores pairing before invalidating and closes before releasing the exact claim', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    events = []
    await unlink()
    expect(events).toEqual(['invalidate', 'close', 'release', 'flush'])
    expect(current().endpoints[0].endpoint).toBe(pairing.endpoint)
    expect(current().sshAccess).toBeUndefined()
    expect(target.owner).toBeUndefined()
  })

  it('retains claim and pending intent on wrong-host proof, then permits cancellation', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('wrong host'))
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('wrong host')
    expect(current().pendingSshAccessOperation?.operation).toBe('link')
    expect(current().sshAccess).toBeUndefined()
    expect(target.owner).toBeDefined()
    expect(mocks.close).toHaveBeenCalledTimes(1)
    await unlink('request')
    expect(target.owner).toBeUndefined()
  })

  it('retries verification failure with the same durable intent', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('unverifiable'))
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow()
    await linkRuntimeSshAccess(userDataPath, request())
    expect(current().sshAccess).toBeDefined()
  })

  it.each(['host', 'generation', 'owner'] as const)(
    'fences %s reassignment during authenticated proof',
    async (field) => {
      mocks.verify.mockImplementationOnce(async () => {
        target = {
          ...target,
          ...(field === 'host'
            ? { host: 'elsewhere' }
            : field === 'generation'
              ? { generation: 4 }
              : { owner: createManagedOrcadSshOwner('other') })
        }
        return { verifiedRuntimeId: 'runtime', verifiedPairing: pairing }
      })
      await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('changed')
      expect(current().sshAccess).toBeUndefined()
      expect(mocks.close).toHaveBeenCalled()
      await expect(unlink('request')).rejects.toThrow('changed')
      expect(events).not.toContain('release')
    }
  )

  it.each([1, 2])('never connects when durable flush %s fails', async (flushNumber) => {
    if (flushNumber === 2) {
      mocks.flush.mockResolvedValueOnce(undefined)
    }
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('disk full')
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(current().pendingSshAccessOperation).toBeDefined()
    expect(!!target.owner).toBe(flushNumber === 2)
  })

  it('resumes unlink after release flush failed without releasing another owner', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(unlink()).rejects.toThrow('disk full')
    expect(target.owner).toBeUndefined()
    await unlink()
    expect(events.filter((event) => event === 'release')).toHaveLength(1)
    expect(current().pendingSshAccessOperation).toBeUndefined()
  })

  it('does not release a new owner when retrying an interrupted unlink', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(unlink()).rejects.toThrow('disk full')
    target = { ...target, owner: createManagedOrcadSshOwner('other') }
    await expect(unlink()).rejects.toThrow('changed')
    expect(events.filter((event) => event === 'release')).toHaveLength(1)
    expect(current().pendingSshAccessOperation?.operation).toBe('unlink')
  })

  it('refuses direct authority even on an already claimed retry', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('offline'))
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow()
    mocks.preflight.mockReturnValue({
      blockers: [{ code: 'orcad_migration_direct_ssh_repositories' }]
    })
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow(
      'direct SSH authority'
    )
    expect(mocks.connect).toHaveBeenCalledTimes(1)
  })

  it('rejects provisioning, cutover, and missing durable generations without connecting', async () => {
    target.orcadProvisioning = { name: 'host', requestId: 'provision' }
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('provisioning')
    target.orcadProvisioning = undefined
    cutovers = [{ manifest: { source: { sshTargetId: target.id } } }]
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('cutover')
    cutovers = []
    target.generation = undefined
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('generation')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('refuses a connected direct provider even when it has no catalog or leases', async () => {
    mocks.hasDirectAuthority.mockReturnValue(true)
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow(
      'Disconnect direct SSH authority'
    )
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(current().pendingSshAccessOperation).toBeUndefined()
  })

  it('treats a lost successful unlink response as an idempotent no-op', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    const unlinked = await unlink()
    const before = [...events]
    expect(await unlink()).toEqual(unlinked)
    expect(events).toEqual(before)
  })

  it('hashes connection identity, not display state or owner', () => {
    const hash = fingerprintRuntimeSshTarget(target)
    expect(
      fingerprintRuntimeSshTarget({
        ...target,
        label: 'renamed',
        lastRequiredPassphrase: true,
        owner: createManagedOrcadSshOwner('other')
      })
    ).toBe(hash)
    expect(fingerprintRuntimeSshTarget({ ...target, proxyCommand: 'other-proxy' })).not.toBe(hash)
  })

  it('strictly validates ports and request IDs', () => {
    expect(() => linkRuntimeSshAccess(userDataPath, { ...request(), remotePort: 0 })).toThrow()
    expect(() =>
      linkRuntimeSshAccess(userDataPath, { ...request(), requestId: '../other' })
    ).toThrow()
    expect(mocks.infrastructure).not.toHaveBeenCalled()
  })
})
