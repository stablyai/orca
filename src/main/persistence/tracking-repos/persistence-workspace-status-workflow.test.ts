import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'

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
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('preserves workflows above 20 statuses across load, write, and restart', async () => {
    const imported = Array.from({ length: 21 }, (_, index) => ({
      id: `state-${index + 1}`,
      label: `State ${index + 1}`
    })).toReversed()
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: { workspaceStatuses: imported },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })

    const store = await createStore()
    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      imported.map((status) => status.id)
    )

    const authored = Array.from({ length: 64 }, (_, index) => ({
      id: `final-${String(index + 1).padStart(3, '0')}`,
      label: `Final ${index + 1}`
    })).toReversed()
    store.updateUI({ workspaceStatuses: authored })
    store.flush()

    expect(store.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      authored.map((status) => status.id)
    )
    expect(
      (readDataFile() as PersistedState).ui.workspaceStatuses?.map((status) => status.id)
    ).toEqual(authored.map((status) => status.id))

    const restarted = await createStore()
    expect(restarted.getUI().workspaceStatuses?.map((status) => status.id)).toEqual(
      authored.map((status) => status.id)
    )
  })
})
