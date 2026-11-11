import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { RpcCallerScope } from '../../rpc-caller-scope'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { SSH_EDITABLE_TARGET_FIELDS } from '../../../../../shared/ssh-target-management'
import { SSH_METHODS } from './ssh'

const mocks = vi.hoisted(() => ({
  getRegisteredSshState: vi.fn(),
  listRegisteredSshTargets: vi.fn(),
  mutations: { add: vi.fn(), update: vi.fn(), remove: vi.fn() },
  getSshConnectionManager: vi.fn(),
  browseSshDirectory: vi.fn()
}))

vi.mock('../../../../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: vi.fn(),
  getRegisteredSshState: mocks.getRegisteredSshState,
  getRegisteredSshTargetMutations: () => mocks.mutations,
  getSshConnectionManager: mocks.getSshConnectionManager,
  listRegisteredRemovedSshTargetLabels: vi.fn(() => ({})),
  listRegisteredSshTargets: mocks.listRegisteredSshTargets
}))

vi.mock('../../../../ssh/filesystem/ssh-remote-directory-browse', () => ({
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
})
