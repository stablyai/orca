import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineRecord } from '../../shared/machine-inventory'
import {
  VALID_ED25519_HOST_KEY,
  resetSsh2ClientState
} from '../ssh/__tests__/ssh-connection-test-client'
import { createCallbacks } from '../ssh/connection/ssh-connection-test-fixtures'
import { SshConnectionManager } from '../ssh/connection/ssh-connection-manager'
import { SshConnectionStore } from '../ssh/connection/ssh-connection-store'
import { createMockStore } from '../ssh/connection/ssh-connection-store-test-fixture'
import { connectMachineSsh, machineSshTargetId, type MachineSshTargets } from './machine-connect'

vi.mock('ssh2', async () =>
  (await import('../ssh/__tests__/ssh-connection-test-client')).createSsh2Module()
)
vi.mock('../ssh/system-transport/system-ssh-binary', async () =>
  (await import('../ssh/connection/ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../ssh/system-transport/system-ssh-args', async (importOriginal) =>
  (await import('../ssh/connection/ssh-connection-test-harness')).withSystemSshArgsMocks(
    await importOriginal()
  )
)
vi.mock('../ssh/system-transport/system-ssh-command', async (importOriginal) =>
  (await import('../ssh/connection/ssh-connection-test-harness')).withSystemSshCommandMocks(
    await importOriginal()
  )
)
vi.mock('../ssh/ssh-control-socket', async () =>
  (await import('../ssh/connection/ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../ssh/config/ssh-config-parser', async () =>
  (await import('../ssh/connection/ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../ssh/config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('../ssh/connection/ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
)

const record: MachineRecord = {
  id: 'sbx-1',
  name: 'dev',
  lifetime: 'persistent',
  state: 'running',
  createdAt: '2026-10-18T00:00:00Z',
  providerKey: 'plugin:acme.omarchy/omarchy',
  lastSeenAt: 1
}

// The test ssh2 server's key, so verification against the pins succeeds.
const PRESENTED = createHash('sha256')
  .update(VALID_ED25519_HOST_KEY)
  .digest('base64')
  .replace(/=+$/, '')
const SPARE = `SHA256:${'C'.repeat(43)}`

const access = (fingerprints: string[]) => ({
  kind: 'ssh' as const,
  host: 'example.com',
  port: 22,
  user: 'deploy',
  projectRoot: '/home/deploy',
  hostKeyFingerprints: fingerprints
})

/** A real connection manager behind the machine connect, so session reuse is the shipped one. */
function harness() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every Store method SshConnectionStore calls.
  const store = new SshConnectionStore(createMockStore() as never)
  const manager = new SshConnectionManager(createCallbacks())
  const targets: MachineSshTargets = {
    getTarget: (id) => store.getTarget(id),
    ensureTarget: (id, fields) => store.ensureMachineOwnedTarget(id, fields),
    updateTarget: (id, updates) => store.updateTarget(id, updates),
    connect: async (id) => (await manager.connect(store.getTarget(id)!)).getState(),
    disconnect: (id) => manager.disconnect(id)
  }
  return { manager, targets, id: machineSshTargetId(record.providerKey, record.id) }
}

describe('machine connect against the real connection manager', () => {
  beforeEach(() => {
    resetSsh2ClientState()
  })

  it('reuses the session while the pins are unchanged', async () => {
    const { manager, targets, id } = harness()
    await connectMachineSsh(targets, record, access([`SHA256:${PRESENTED}`]))
    const first = manager.getConnection(id)
    await connectMachineSsh(targets, record, access([`SHA256:${PRESENTED}`]))
    expect(manager.getConnection(id)).toBe(first)
  })

  it('opens a new session verified against rotated pins instead of reusing the old one', async () => {
    const { manager, targets, id } = harness()
    await connectMachineSsh(targets, record, access([`SHA256:${PRESENTED}`]))
    const first = manager.getConnection(id)
    await connectMachineSsh(targets, record, access([`SHA256:${PRESENTED}`, SPARE]))
    const second = manager.getConnection(id)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    const owner = second?.getTarget().owner
    expect(owner?.type === 'machine' ? owner.hostKeyFingerprints : null).toEqual([
      `SHA256:${PRESENTED}`,
      SPARE
    ])
  })
})
