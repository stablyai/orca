import { registerProjectGroupingPersistenceTests } from './project-grouping-persistence.spec'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState,
  writeDataFile,
  readDataFile
} from '../persistence-test-harness'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

let hasCreatedStoreInCase = false

async function createStore() {
  if (hasCreatedStoreInCase) {
    vi.resetModules()
  }
  const { setSecretStore } = await import('../../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    },
    describeProtectionGap: () => null
  })
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  const { Store } = await import('../loading-store/store')
  const { initDataPath } = await import('../loading-store/user-data-path')
  // Reinstall this test’s userData path after resetModules before initializing Store.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    hasCreatedStoreInCase = false
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  registerProjectGroupingPersistenceTests(createStore)

  // Paired-client updates omit local ordering fields; omission must preserve the desktop’s own values.

  it('updateUI survives a throwing UI listener so the shutdown checkpoint is not vetoed', async () => {
    const store = await createStore()
    const laterListener = vi.fn()
    store.onUIChanged(() => {
      throw new TypeError('Object has been destroyed')
    })
    store.onUIChanged(laterListener)

    expect(() => store.updateUI({ sidebarWidth: 321 })).not.toThrow()
    expect(store.getUI().sidebarWidth).toBe(321)
    expect(laterListener).toHaveBeenCalledWith(expect.objectContaining({ sidebarWidth: 321 }))
  })

  it('does not expose or accept UI shadow writes for main-owned feature telemetry markers', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {
        featureInteractionTelemetryBuckets: { tasks: 'count_1000_plus' }
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {},
      featureInteractionTelemetryBuckets: { tasks: 'count_2' }
    })

    const store = await createStore()

    expect('featureInteractionTelemetryBuckets' in (store.getUI() as Record<string, unknown>)).toBe(
      false
    )

    store.updateUI({
      featureInteractionTelemetryBuckets: { tasks: 'count_500_999' }
    } as never)
    store.flush()

    const persisted = readDataFile() as PersistedState & {
      ui: Record<string, unknown>
    }
    expect(persisted.featureInteractionTelemetryBuckets).toEqual({ tasks: 'count_2' })
    expect(persisted.ui.featureInteractionTelemetryBuckets).toBeUndefined()
  })

  // Preserve sealed relay-era recovery records for downgrades.
  const legacyRecovery = {
    targetId: 'ssh-1',
    clientInstanceId: 'client-1',
    serverBuildId: 'relay-build-1',
    clientGeneration: 3,
    ownerGeneration: 5,
    ownerLease: 'secret-owner-lease',
    outputFlowControl: { version: 1, windowSu: 256 * 1024 }
  }
  const sealedOwnerLease = (lease: string) =>
    Buffer.from(`encrypted:${lease}`, 'utf-8').toString('base64')

  it('removes persisted SSH PTY consumer ownership with its target', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      sshTargets: [
        { id: 'ssh-1', label: 'SSH 1', host: 'example.test', port: 22, username: 'orca' }
      ],
      sshPtyConsumerRecoveries: [
        { ...legacyRecovery, ownerLease: sealedOwnerLease(legacyRecovery.ownerLease) }
      ]
    })
    const store = await createStore()

    store.removeSshTarget('ssh-1')
    store.flush()

    expect(readDataFile()).toHaveProperty('sshPtyConsumerRecoveries', [])
  })
})
