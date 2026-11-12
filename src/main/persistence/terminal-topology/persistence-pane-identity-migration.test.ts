import {
  closeTestStores,
  createStore,
  testState,
  workspaceRepos,
  writeDataFile
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../persistence-session-fixtures'

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
    agentHookServer.stop()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('restores cross-tab pane authority aliases before hook ingestion', async () => {
    const physicalPaneKey = makePaneKey('tab-source', TEST_LEAF_1)
    const ownerPaneKey = makePaneKey('tab-target', TEST_LEAF_2)
    writeDataFile({
      schemaVersion: 1,
      repos: workspaceRepos('wt1'),
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      legacyPaneKeyAliasEntries: [
        {
          ptyId: 'pty-detached',
          legacyPaneKey: physicalPaneKey,
          stablePaneKey: ownerPaneKey,
          updatedAt: 10
        }
      ]
    })

    await createStore()
    const { agentHookServer } = await import('../../agent-hooks/server/agent-hook-server')
    agentHookServer.ingestTerminalStatus({
      paneKey: physicalPaneKey,
      tabId: 'tab-source',
      worktreeId: 'wt1',
      payload: { state: 'working', prompt: 'detached after restart' }
    })

    expect(agentHookServer.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: ownerPaneKey,
        tabId: 'tab-target',
        prompt: 'detached after restart'
      })
    ])
  })

  // Large alias migrations need extra timeout headroom on loaded CI shards.
})
