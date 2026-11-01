import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  resolveEnvironment
} from '../../shared/runtime-environment-store'
import { readPersistedEnvironmentStore } from '../../shared/runtime-environment-store-file'
import { writeRuntimeEnvironmentSidecarEntry } from '../../shared/runtime-environment-sidecar'
import type { SshTarget } from '../../shared/ssh-types'

const mocks = vi.hoisted(() => ({
  infrastructure: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  start: vi.fn(),
  close: vi.fn(),
  ensure: vi.fn(),
  verify: vi.fn(),
  flush: vi.fn(),
  preflight: vi.fn()
}))
vi.mock('../managed-server/lifecycle/orcad-managed-runtime-context', () => ({
  requireManagedOrcadInfrastructure: mocks.infrastructure
}))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  startOrcadManagedTunnel: mocks.start,
  closeOrcadManagedTunnel: mocks.close,
  ensureOrcadManagedTunnel: mocks.ensure
}))
vi.mock('./runtime-ssh-access-verification', () => ({
  verifyRuntimeEnvironmentSshTunnel: mocks.verify
}))
import { linkRuntimeSshAccess, unlinkRuntimeSshAccess } from './runtime-ssh-access'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-target-fingerprint'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://example.test/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'secret',
  pairedDeviceId: 'client'
}

describe('independent runtime SSH access coordinator', () => {
  let userDataPath: string
  let environmentId: string
  let target: SshTarget
  let events: string[]
  let claimOptions: unknown
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
        },
        endSshSession: async (sshTargetId) => {
          expect(current().sshAccess).toBeUndefined()
          events.push(`end-session:${sshTargetId}`)
        }
      }
    )
  beforeEach(() => {
    vi.resetAllMocks()
    events = []
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
      connectionManager: { connect: mocks.connect, disconnect: mocks.disconnect },
      claims: {
        listTargets: () => [target],
        preflight: mocks.preflight,
        flush: mocks.flush,
        claim: (_targetId: string, _environmentId: string, options: unknown) => {
          expect(current().pendingSshAccessOperation?.operation).toBe('link')
          events.push('claim')
          claimOptions = options
          target = { ...target, orcadFence: { environmentId: environmentId } }
          return target
        },
        release: () => {
          expect(current().pendingSshAccessOperation?.operation).toBe('unlink')
          events.push('release')
          target = { ...target, orcadFence: undefined }
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
        verifiedConnection: pairedRuntimeConnectionFromOffer({
          ...pairing,
          endpoint: 'ws://127.0.0.1:41000'
        }),
        runtimeStatus: {}
      }
    })
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it.each(['link', 'unlink'])(
    'refuses %s before side effects during host reconciliation',
    async (operation) => {
      const environments = readPersistedEnvironmentStore(userDataPath).environments
      const persisted = environments.find((entry) => entry.id === environmentId)
      if (!persisted) {
        throw new Error('missing environment')
      }
      writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, persisted, {
        reconciliation: {
          version: 1,
          stage: 'prepared',
          requestId: 'reconciliation',
          canonicalEnvironmentId: environmentId,
          runtimeId: 'host-runtime',
          preparedAt: 1,
          registrations: [
            { environmentId, authorityDigest: 'a'.repeat(64) },
            { environmentId: 'peer', authorityDigest: 'b'.repeat(64) }
          ]
        }
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

  it('persists intent then claim before connecting and publishes redacted authenticated access', async () => {
    const result = await linkRuntimeSshAccess(userDataPath, request())
    expect(events).toEqual(['flush', 'claim', 'flush', 'connect', 'tunnel', 'verify'])
    expect(result.sshAccess?.sshTargetId).toBe('target')
    expect(result.orcadDeployment).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(current().pendingSshAccessOperation).toBeUndefined()
    expect(mocks.preflight).toHaveBeenCalledWith('target')
  })

  it('names the saved dependency when dependent state blocks an SSH access link', async () => {
    mocks.preflight.mockReturnValue({
      blockers: [
        {
          code: 'orcad_migration_dependent_state',
          category: 'client-owned-state',
          dependencies: [{ kind: 'worktree-metadata', count: 1, names: ['repo-1::/srv/app'] }]
        }
      ]
    })
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow(
      /orcad_migration_dependent_state\. [\s\S]*worktree-metadata ×1 \(repo-1::\/srv\/app\)/
    )
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.flush).not.toHaveBeenCalled()
    expect(events).not.toContain('claim')
  })

  it('links an SSH target whose saved port forwards the linked host restores', async () => {
    mocks.preflight.mockReturnValue({
      blockers: [
        {
          code: 'orcad_migration_saved_port_forwards',
          category: 'client-owned-state',
          portForwards: [{ localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }]
        }
      ]
    })
    const result = await linkRuntimeSshAccess(userDataPath, request())
    expect(result.sshAccess?.sshTargetId).toBe('target')
    // The claim's own empty-target check must let them through too.
    expect(claimOptions).toMatchObject({ allowSavedPortForwards: true })
  })

  it('cancels a pending connect and starts no tunnel when the link is aborted', async () => {
    const controller = new AbortController()
    mocks.connect.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          mocks.disconnect.mockImplementationOnce(async () => {
            fail(new Error('cancelled'))
            return undefined
          })
        })
    )
    const link = linkRuntimeSshAccess(userDataPath, request(), { signal: controller.signal })
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalled())
    controller.abort()
    await expect(link).rejects.toThrow('cancelled')
    expect(mocks.disconnect).toHaveBeenCalledWith('target')
    expect(mocks.start).not.toHaveBeenCalled()
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

  it('proves a ports-only host reaches the server, then leaves the server connection alone', async () => {
    const invalidateTransport = vi.fn()
    const portsOnly = { ...request(), portsOnly: true as const }
    const result = await linkRuntimeSshAccess(userDataPath, portsOnly, { invalidateTransport })
    expect(events).toEqual(['flush', 'claim', 'flush', 'connect', 'tunnel', 'verify', 'close'])
    expect(result.sshAccess).toMatchObject({ sshTargetId: 'target', portsOnly: true })
    expect(result.connectionDependency).toBeUndefined()
    // A retried link changes nothing either.
    await linkRuntimeSshAccess(userDataPath, portsOnly, { invalidateTransport })
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('different')
    expect(mocks.ensure).not.toHaveBeenCalled()

    events = []
    await unlink()
    expect(events).toEqual(['close', 'end-session:target', 'release', 'flush'])
    expect(invalidateTransport).not.toHaveBeenCalled()
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
    expect(target?.orcadFence).toEqual({ environmentId: environmentId })
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
    expect(events).toEqual(['invalidate', 'close', 'end-session:target', 'release', 'flush'])
    expect(current().endpoints[0].endpoint).toBe(pairing.endpoint)
    expect(current().sshAccess).toBeUndefined()
    expect(target.orcadFence).toBeUndefined()
  })

  it('retains claim and pending intent on wrong-host proof, then permits cancellation', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('wrong host'))
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('wrong host')
    expect(current().pendingSshAccessOperation?.operation).toBe('link')
    expect(current().sshAccess).toBeUndefined()
    expect(target.orcadFence).toBeDefined()
    expect(mocks.close).toHaveBeenCalledTimes(1)
    await unlink('request')
    expect(target.orcadFence).toBeUndefined()
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
              : { orcadFence: { environmentId: 'other' } })
        }
        return {
          verifiedRuntimeId: 'runtime',
          verifiedConnection: pairedRuntimeConnectionFromOffer(pairing)
        }
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
    expect(!!target.orcadFence).toBe(flushNumber === 2)
  })

  it('resumes unlink after release flush failed without releasing another owner', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(unlink()).rejects.toThrow('disk full')
    expect(target.orcadFence).toBeUndefined()
    // The link already left the Ports tab, so its session and forwards ended before the failure.
    expect(events).toContain('end-session:target')
    await unlink()
    expect(events.filter((event) => event === 'release')).toHaveLength(1)
    expect(current().pendingSshAccessOperation).toBeUndefined()
  })

  it('ends the session even when invalidating the transport fails after the link left', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    const endSshSession = vi.fn(async () => {})
    await expect(
      unlinkRuntimeSshAccess(
        userDataPath,
        { selector: environmentId, requestId: 'unlink' },
        {
          invalidateTransport: () => {
            throw new Error('transport busy')
          },
          endSshSession
        }
      )
    ).rejects.toThrow('transport busy')
    expect(current().sshAccess).toBeUndefined()
    expect(endSshSession).toHaveBeenCalledExactlyOnceWith('target')
  })

  it('does not release a new owner when retrying an interrupted unlink', async () => {
    await linkRuntimeSshAccess(userDataPath, request())
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(unlink()).rejects.toThrow('disk full')
    target = { ...target, orcadFence: { environmentId: 'other' } }
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

  it('rejects provisioning and missing durable generations without connecting', async () => {
    target.orcadProvisioning = { name: 'host', requestId: 'provision' }
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('provisioning')
    target.orcadProvisioning = undefined
    target.generation = undefined
    await expect(linkRuntimeSshAccess(userDataPath, request())).rejects.toThrow('generation')
    expect(mocks.connect).not.toHaveBeenCalled()
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
        orcadFence: { environmentId: 'other' }
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
