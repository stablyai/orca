import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { RpcCallerScope } from '../rpc-caller-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_EDITABLE_TARGET_FIELDS } from '../../../../shared/ssh-target-management'
import { SSH_METHODS } from './ssh'

const mocks = vi.hoisted(() => ({
  getRegisteredSshState: vi.fn(),
  listRegisteredSshTargets: vi.fn(),
  mutations: { add: vi.fn(), update: vi.fn(), remove: vi.fn() },
  getSshConnectionManager: vi.fn(),
  browseSshDirectory: vi.fn()
}))

vi.mock('../../../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: vi.fn(),
  getRegisteredSshState: mocks.getRegisteredSshState,
  getRegisteredSshTargetMutations: () => mocks.mutations,
  getSshConnectionManager: mocks.getSshConnectionManager,
  listRegisteredRemovedSshTargetLabels: vi.fn(() => ({})),
  listRegisteredSshTargets: mocks.listRegisteredSshTargets
}))

vi.mock('../../../ssh/ssh-remote-directory-browse', () => ({
  browseSshDirectory: mocks.browseSshDirectory
}))

const SECRET_PASSWORD = 'hunter2-password'
const SECRET_PASSPHRASE = 'key-passphrase-value'

// A stored row carrying keys no paired client may see: secrets (as a malformed or future profile
// might hold) and main-owned fields.
const storedTarget = {
  id: 'ssh-1',
  label: 'Dev box',
  host: 'dev.internal',
  port: 2222,
  username: 'me',
  identityFile: '~/.ssh/id_ed25519',
  jumpHost: 'bastion',
  source: 'manual',
  generation: 4,
  password: SECRET_PASSWORD,
  passphrase: SECRET_PASSPHRASE,
  lastRequiredPassphrase: true,
  remoteRuntimeResolution: { rung: 'A' },
  owner: undefined
}

const validInput = { label: 'Build', host: 'build.internal', port: 22, username: 'ci' }

const runtime = new OrcaRuntimeService()

function dispatch(method: string, params?: unknown, callerScope?: RpcCallerScope) {
  const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS, callerScope })
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method, params }
  return dispatcher.dispatch(request)
}

function expectNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(SECRET_PASSWORD)
  expect(serialized).not.toContain(SECRET_PASSPHRASE)
  expect(serialized).not.toContain('lastRequiredPassphrase')
  expect(serialized).not.toContain('remoteRuntimeResolution')
}

function listedTargetKeys(response: unknown): string[] {
  const parsed: unknown = JSON.parse(JSON.stringify(response))
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
    return []
  }
  const { result } = parsed
  if (typeof result !== 'object' || result === null || !('targets' in result)) {
    return []
  }
  const [first] = Array.isArray(result.targets) ? result.targets : []
  return typeof first === 'object' && first !== null ? Object.keys(first) : []
}

const ALLOWED_VIEW_KEYS = new Set<string>([
  ...SSH_EDITABLE_TARGET_FIELDS,
  'id',
  'generation',
  'connected',
  'connectionStatus',
  'remotePlatform',
  'source',
  'managedServer'
])

describe('server SSH target management RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getRegisteredSshState.mockReturnValue({ status: 'connected' })
  })

  it('lists editable fields only; secrets and main-owned fields never leave the server', async () => {
    mocks.listRegisteredSshTargets.mockReturnValue([storedTarget])

    const response = await dispatch('ssh.listEditableTargets')

    expect(response).toMatchObject({
      ok: true,
      result: {
        targets: [
          {
            id: 'ssh-1',
            label: 'Dev box',
            host: 'dev.internal',
            port: 2222,
            username: 'me',
            identityFile: '~/.ssh/id_ed25519',
            jumpHost: 'bastion',
            generation: 4,
            connected: true,
            connectionStatus: 'connected',
            source: 'manual'
          }
        ]
      }
    })
    expectNoSecrets(response)
    expect(listedTargetKeys(response).filter((key) => !ALLOWED_VIEW_KEYS.has(key))).toEqual([])
  })

  it('marks a managed-server host so the client does not offer removal', async () => {
    mocks.listRegisteredSshTargets.mockReturnValue([
      { ...validInput, id: 'ssh-2', orcadFence: { environmentId: 'env-1' } }
    ])

    const response = await dispatch('ssh.listEditableTargets')

    expect(response).toMatchObject({ ok: true, result: { targets: [{ managedServer: true }] } })
    expect(JSON.stringify(response)).not.toContain('orcadFence')
  })

  it.each([
    ['password', SECRET_PASSWORD],
    ['passphrase', SECRET_PASSPHRASE]
  ])('refuses a %s on add or update instead of dropping it silently', async (key, value) => {
    const add = await dispatch('ssh.addTarget', { target: { ...validInput, [key]: value } })
    const update = await dispatch('ssh.updateTarget', {
      targetId: 'ssh-1',
      target: { ...validInput, [key]: value }
    })

    expect(add).toMatchObject({ ok: false })
    expect(update).toMatchObject({ ok: false })
    expect(mocks.mutations.add).not.toHaveBeenCalled()
    expect(mocks.mutations.update).not.toHaveBeenCalled()
    expectNoSecrets([add, update])
  })

  it('refuses main-owned fields a client must not forge', async () => {
    const response = await dispatch('ssh.addTarget', {
      target: { ...validInput, generation: 99, orcadFence: { environmentId: 'env-1' } }
    })

    expect(response).toMatchObject({ ok: false })
    expect(mocks.mutations.add).not.toHaveBeenCalled()
  })

  it('adds through the shared mutation and returns the redacted view', async () => {
    mocks.mutations.add.mockReturnValue({
      target: { ...storedTarget, ...validInput, id: 'ssh-new' },
      repoReadoptions: [{ oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['r1'] }]
    })

    const response = await dispatch('ssh.addTarget', { target: validInput })

    expect(mocks.mutations.add).toHaveBeenCalledWith({
      ...validInput,
      allowRemoteCliControl: false,
      source: 'manual'
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        target: { id: 'ssh-new', host: 'build.internal' },
        repoReadoptions: [{ newTargetId: 'ssh-new', repoIds: ['r1'] }]
      }
    })
    expectNoSecrets(response)
  })

  it('updates with replace semantics so an omitted optional field is cleared', async () => {
    mocks.mutations.update.mockReturnValue({ ...storedTarget, ...validInput })

    const response = await dispatch('ssh.updateTarget', { targetId: 'ssh-1', target: validInput })

    const [targetId, updates] = mocks.mutations.update.mock.calls[0]
    expect(targetId).toBe('ssh-1')
    expect(updates).toMatchObject({ ...validInput, source: 'manual' })
    expect(Object.keys(updates)).toEqual(expect.arrayContaining(['identityFile', 'jumpHost']))
    expect(updates.identityFile).toBeUndefined()
    expect(updates.jumpHost).toBeUndefined()
    expect(response).toMatchObject({ ok: true })
    expectNoSecrets(response)
  })

  it('reads an omitted CLI control switch from an older client as off, and lists it explicitly', async () => {
    mocks.mutations.update.mockReturnValue({ ...storedTarget, ...validInput })
    await dispatch('ssh.updateTarget', { targetId: 'ssh-1', target: validInput })
    expect(mocks.mutations.update.mock.calls[0][1]).toMatchObject({ allowRemoteCliControl: false })

    await dispatch('ssh.updateTarget', {
      targetId: 'ssh-1',
      target: { ...validInput, allowRemoteCliControl: true }
    })
    expect(mocks.mutations.update.mock.calls[1][1]).toMatchObject({ allowRemoteCliControl: true })

    mocks.listRegisteredSshTargets.mockReturnValue([
      { ...validInput, id: 'absent' },
      { ...validInput, id: 'off', allowRemoteCliControl: false }
    ])
    const listed = await dispatch('ssh.listEditableTargets')
    expect(listed).toMatchObject({
      ok: true,
      result: {
        targets: [
          { id: 'absent', allowRemoteCliControl: true },
          { id: 'off', allowRemoteCliControl: false }
        ]
      }
    })
  })

  it('reports an unknown target instead of answering success', async () => {
    mocks.mutations.update.mockReturnValue(null)

    const response = await dispatch('ssh.updateTarget', { targetId: 'gone', target: validInput })

    expect(response).toMatchObject({ ok: false, error: { message: 'SSH target not found: gone' } })
  })

  it('removes through the shared mutation and surfaces its refusal', async () => {
    mocks.mutations.remove.mockResolvedValueOnce(undefined)
    await expect(dispatch('ssh.removeTarget', { targetId: 'ssh-1' })).resolves.toMatchObject({
      ok: true,
      result: { removed: true }
    })
    mocks.mutations.remove.mockRejectedValueOnce(new Error('This host runs a managed Orca server.'))
    await expect(dispatch('ssh.removeTarget', { targetId: 'ssh-2' })).resolves.toMatchObject({
      ok: false
    })
  })

  it('browses a server SSH target over the server connection manager', async () => {
    const manager = { getConnection: vi.fn() }
    mocks.getSshConnectionManager.mockReturnValue(manager)
    mocks.browseSshDirectory.mockResolvedValue({
      entries: [{ name: 'src', isDirectory: true }],
      resolvedPath: '/home/me',
      pathFlavor: 'posix'
    })

    const response = await dispatch('ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' })

    expect(mocks.browseSshDirectory).toHaveBeenCalledWith(manager, 'ssh-1', '~')
    expect(response).toMatchObject({ ok: true, result: { resolvedPath: '/home/me' } })
  })

  it('publishes no client event carrying target data', async () => {
    mocks.listRegisteredSshTargets.mockReturnValue([storedTarget])
    mocks.mutations.add.mockReturnValue({ target: storedTarget, repoReadoptions: [] })
    mocks.mutations.update.mockReturnValue(storedTarget)
    mocks.mutations.remove.mockResolvedValue(undefined)

    const events: unknown[] = []
    const unsubscribe = runtime.onClientEvent((event) => events.push(event))

    await dispatch('ssh.listEditableTargets')
    await dispatch('ssh.addTarget', { target: validInput })
    await dispatch('ssh.updateTarget', { targetId: 'ssh-1', target: validInput })
    await dispatch('ssh.removeTarget', { targetId: 'ssh-1' })
    unsubscribe()

    expectNoSecrets(events)
    expect(JSON.stringify(events)).not.toContain('dev.internal')
  })

  describe('who may manage', () => {
    const MANAGEMENT_CALLS: [string, unknown][] = [
      ['ssh.listEditableTargets', undefined],
      ['ssh.addTarget', { target: validInput }],
      ['ssh.updateTarget', { targetId: 'ssh-1', target: validInput }],
      ['ssh.removeTarget', { targetId: 'ssh-1' }],
      ['ssh.browseDir', { targetId: 'ssh-1', dirPath: '~' }]
    ]

    beforeEach(() => {
      mocks.listRegisteredSshTargets.mockReturnValue([])
      mocks.mutations.add.mockReturnValue({ target: storedTarget, repoReadoptions: [] })
      mocks.mutations.update.mockReturnValue(storedTarget)
      mocks.mutations.remove.mockResolvedValue(undefined)
      mocks.browseSshDirectory.mockResolvedValue({
        entries: [],
        resolvedPath: '/',
        pathFlavor: 'posix'
      })
    })

    it.each(MANAGEMENT_CALLS)(
      'a paired desktop or web client may call %s',
      async (method, params) => {
        await expect(
          dispatch(method, params, { kind: 'runtime-paired', grants: [] })
        ).resolves.toMatchObject({ ok: true })
      }
    )

    it.each(MANAGEMENT_CALLS)('a phone may not call %s', async (method, params) => {
      await expect(dispatch(method, params, { kind: 'mobile' })).resolves.toMatchObject({
        ok: false
      })
    })
  })
})
