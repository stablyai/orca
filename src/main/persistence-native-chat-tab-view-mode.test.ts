import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/config/ssh-config-parser', () => ({
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

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store native-chat tab viewMode persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // Preserve absent viewMode for legacy tabs; renderer hydration supplies terminal mode.
  it('round-trips viewMode for unified tabs and defaults legacy tabs to terminal', async () => {
    const WORKTREE = 'repo1::/worktree'
    writeDataFile({
      schemaVersion: 1,
      repos: [makeRepo({ id: 'repo1', path: '/repo1' })],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: WORKTREE,
        activeTabId: 'chat-tab',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: {},
        unifiedTabs: {
          [WORKTREE]: [
            {
              id: 'chat-tab',
              entityId: 'chat-tab',
              groupId: 'g1',
              worktreeId: WORKTREE,
              contentType: 'terminal',
              label: 'Agent',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              viewMode: 'chat'
            },
            {
              id: 'legacy-tab',
              entityId: 'legacy-tab',
              groupId: 'g1',
              worktreeId: WORKTREE,
              contentType: 'terminal',
              label: 'Legacy',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        tabGroups: {
          [WORKTREE]: [
            {
              id: 'g1',
              worktreeId: WORKTREE,
              activeTabId: 'chat-tab',
              tabOrder: ['chat-tab', 'legacy-tab']
            }
          ]
        }
      }
    })

    const store = await createStore()
    const restored = store.getWorkspaceSession().unifiedTabs?.[WORKTREE] ?? []
    const chatTab = restored.find((tab) => tab.id === 'chat-tab')
    const legacyTab = restored.find((tab) => tab.id === 'legacy-tab')

    expect(chatTab?.viewMode).toBe('chat')
    expect(legacyTab?.viewMode).toBeUndefined()
  })
})
