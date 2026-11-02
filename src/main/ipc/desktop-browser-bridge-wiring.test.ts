import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'

const { targets } = vi.hoisted(() => {
  const targets: SshTarget[] = []
  return { targets }
})

vi.mock('electron', () => ({ webContents: { fromId: () => null } }))
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../runtime/rpc/methods', () => ({ ALL_RPC_METHODS: [] }))
vi.mock('./ssh/ssh-ipc-context', () => ({ persistedStore: null }))
vi.mock('../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: vi.fn()
}))
vi.mock('../ssh/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSshTargetRegistryStore: () => ({ listTargets: () => targets })
}))
vi.mock('../../shared/managed-orcad-ssh-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getManagedOrcadFenceEnvironmentId: (target: SshTarget) => `env-${target.id}`
}))
vi.mock('./runtime-environments/runtime-environment-connectivity-handlers', () => ({
  isRuntimeEnvironmentManuallyDisconnected: () => false
}))
vi.mock('../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveEnvironment: (_userDataPath: string, environmentId: string) => ({ environmentId })
}))
vi.mock('../../shared/runtime-environments', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrcadSshDeployment: ({ environmentId }: { environmentId: string }) => ({
    sshTargetId: environmentId.slice('env-'.length)
  })
}))

import { listDesktopBrowserBridgeCandidates } from './desktop-browser-bridge-wiring'

const host = (id: string, extra: Partial<SshTarget> = {}): SshTarget => ({
  id,
  label: id,
  host: `${id}.example.com`,
  port: 22,
  username: 'me',
  ...extra
})
const connected = {
  getState: (targetId: string): SshConnectionState => ({
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  })
}

beforeEach(() => {
  targets.length = 0
})

describe('which managed hosts may attach the desktop browser bridge', () => {
  it('attaches a host with no saved switch or an explicit true, never an explicit false', () => {
    targets.push(
      host('absent'),
      host('on', { allowRemoteCliControl: true }),
      host('off', { allowRemoteCliControl: false })
    )

    const candidates = listDesktopBrowserBridgeCandidates('/user-data', connected)

    expect(candidates.map((candidate) => candidate.targetId)).toEqual(['absent', 'on'])
  })
})
