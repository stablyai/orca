import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { normalizeSshTarget } from '../persistence/leasing-ssh-ptys/ssh-normalization'

const mocks = vi.hoisted(() => ({
  targets: [] as SshTarget[],
  completed: [] as string[],
  deploy: vi.fn(),
  flush: vi.fn(),
  add: vi.fn(),
  rotate: vi.fn(),
  targetStore: {} as Record<string, unknown>
}))

vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => mocks.targetStore
}))
vi.mock('./orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('./ssh-provider-authority', () => ({ rotateSshProviderAuthority: mocks.rotate }))

import {
  createOrcadSshHost,
  listPendingOrcadSshProvisioning,
  resumeOrcadSshHost
} from './orcad-ssh-provisioning'

const request = {
  requestId: 'request-1',
  name: 'Build host',
  target: { label: 'Build host', host: 'builder', port: 22, username: 'dev' }
}
const deployed = {
  outcome: 'created',
  environment: { id: 'environment-1' },
  activeVersion: 'bun-1'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.targets.length = 0
  mocks.completed.length = 0
  mocks.flush.mockReset().mockResolvedValue(undefined)
  mocks.deploy.mockReset().mockResolvedValue(deployed)
  mocks.add.mockImplementation((input) => {
    const target = normalizeSshTarget({
      ...input,
      id: `ssh-${mocks.targets.length + 1}`,
      generation: 1
    })
    mocks.targets.push(target)
    return target
  })
  mocks.targetStore = {
    addTarget: mocks.add,
    lastRepoReadoptions: [],
    getOrcadMigrationStore: () => ({
      getSshTargets: () => mocks.targets,
      flushPendingOrThrowAsync: mocks.flush,
      listOrcadMigrationSourceCutovers: () =>
        mocks.completed.map((sshTargetId) => ({
          phase: 'source-retired',
          manifest: { source: { sshTargetId } }
        }))
    })
  }
})

describe('managed SSH host provisioning', () => {
  it('persists intent before running the existing migration/deployment preflight', async () => {
    mocks.deploy.mockImplementation(async () => {
      expect(mocks.flush).toHaveBeenCalledOnce()
      expect(mocks.targets[0]?.orcadProvisioning).toEqual({
        requestId: 'request-1',
        name: 'Build host'
      })
      return deployed
    })
    await expect(createOrcadSshHost('/profile', request)).resolves.toMatchObject({
      requestId: 'request-1',
      name: 'Build host',
      sshTargetId: 'ssh-1',
      result: deployed
    })
    expect(mocks.deploy).toHaveBeenCalledWith('/profile', {
      name: 'Build host',
      sshTargetId: 'ssh-1'
    })
  })

  it('does not contact a host if durable intent publication fails', async () => {
    mocks.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(createOrcadSshHost('/profile', request)).rejects.toThrow('disk full')
    expect(mocks.deploy).not.toHaveBeenCalled()
    await resumeOrcadSshHost('/profile', 'request-1')
    expect(mocks.add).toHaveBeenCalledOnce()
  })

  it('retains the same request across preflight refusal and a reconstructed target store', async () => {
    mocks.deploy.mockRejectedValueOnce(new Error('live-or-unverifiable terminal leases'))
    await expect(createOrcadSshHost('/profile', request)).resolves.toMatchObject({
      result: { outcome: 'pending', reason: 'live-or-unverifiable terminal leases' }
    })
    mocks.targets.splice(0, 1, JSON.parse(JSON.stringify(mocks.targets[0])))
    expect(listPendingOrcadSshProvisioning()).toEqual([
      { requestId: 'request-1', name: 'Build host', sshTargetId: 'ssh-1' }
    ])
    await expect(resumeOrcadSshHost('/profile', 'request-1')).resolves.toMatchObject({
      result: deployed
    })
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.deploy).toHaveBeenCalledTimes(2)
  })

  it('preserves re-adopted catalog identities and fences old provider authority', async () => {
    const readoptions = [{ oldTargetId: 'old', newTargetId: 'ssh-1', repoIds: ['repo-1'] }]
    mocks.targetStore.lastRepoReadoptions = readoptions
    const result = await createOrcadSshHost('/profile', request)
    expect(result.repoReadoptions).toEqual(readoptions)
    expect(mocks.rotate).toHaveBeenCalledWith('old')
    expect(mocks.rotate).toHaveBeenCalledWith('ssh-1')
    expect(mocks.deploy).toHaveBeenCalledOnce()
  })

  it('returns activation deferral without force, deletion, or another target', async () => {
    const deferred = {
      outcome: 'deferred',
      reason: 'unverifiable',
      code: 'blocked',
      candidateVersion: 'bun-1'
    }
    mocks.deploy.mockResolvedValueOnce(deferred)
    await expect(createOrcadSshHost('/profile', request)).resolves.toMatchObject({
      result: deferred
    })
    expect(listPendingOrcadSshProvisioning()).toHaveLength(1)
    expect(mocks.targets).toHaveLength(1)
  })

  it('serializes repeated requests and preserves normalization on exact retries', async () => {
    const normalizedRequest = {
      ...request,
      target: { ...request.target, relayGracePeriodSeconds: 10800 }
    }
    await Promise.all([
      createOrcadSshHost('/profile', normalizedRequest),
      createOrcadSshHost('/profile', normalizedRequest)
    ])
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.targets).toHaveLength(1)
  })

  it('rejects request identity reuse for different host data or name', async () => {
    await createOrcadSshHost('/profile', request)
    await expect(createOrcadSshHost('/profile', { ...request, name: 'Other' })).rejects.toThrow(
      'already belongs'
    )
    await expect(
      createOrcadSshHost('/profile', {
        ...request,
        target: { ...request.target, identityFile: 'other' }
      })
    ).rejects.toThrow('already belongs')
    expect(mocks.deploy).toHaveBeenCalledOnce()
  })

  it('does not create a duplicate raw host when another request registered the endpoint', async () => {
    await createOrcadSshHost('/profile', request)
    await expect(
      createOrcadSshHost('/profile', { ...request, requestId: 'request-2' })
    ).rejects.toThrow('already registered')
    expect(mocks.add).toHaveBeenCalledOnce()
  })

  it('does not duplicate an occupied config alias or endpoint under a different label', async () => {
    await createOrcadSshHost('/profile', request)
    await expect(
      createOrcadSshHost('/profile', {
        ...request,
        requestId: 'request-2',
        target: { ...request.target, configHost: 'BUILDER', host: 'resolved-address' }
      })
    ).rejects.toThrow('already registered')
    await expect(
      createOrcadSshHost('/profile', {
        ...request,
        requestId: 'request-3',
        target: { ...request.target, label: 'Different', configHost: 'other-alias' }
      })
    ).rejects.toThrow('already registered')
  })

  it.each([
    { configHost: 3 },
    { identityFile: false },
    { gssapiAuthentication: 'yes' },
    { systemSshConnectionReuse: 1 },
    { portForwards: [{ localPort: -1 }] }
  ])('rejects malformed optional connection fields before durable registration: %j', (invalid) => {
    expect(() =>
      createOrcadSshHost('/profile', {
        ...request,
        target: { ...request.target, ...invalid } as never
      })
    ).toThrow()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('omits completed requests from pending discovery but retains their retry identity', async () => {
    await createOrcadSshHost('/profile', request)
    mocks.completed.push('ssh-1')
    expect(listPendingOrcadSshProvisioning()).toEqual([])
    await resumeOrcadSshHost('/profile', 'request-1')
    expect(mocks.add).toHaveBeenCalledOnce()
  })

  it('does not provision imported config entries without explicit intent', () => {
    mocks.targets.push({ ...request.target, id: 'imported', source: 'ssh-config' })
    expect(listPendingOrcadSshProvisioning()).toEqual([])
    expect(mocks.deploy).not.toHaveBeenCalled()
  })

  it('rejects invalid input and unknown retry IDs without writing a target', async () => {
    expect(() => createOrcadSshHost('/profile', { ...request, requestId: '' })).toThrow(
      'request id'
    )
    expect(() =>
      createOrcadSshHost('/profile', { ...request, target: { ...request.target, port: 0 } })
    ).toThrow('port')
    await expect(resumeOrcadSshHost('/profile', 'missing')).rejects.toThrow('not found')
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
