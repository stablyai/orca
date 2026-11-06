import {
  closeTestStores,
  testState,
  createStore,
  readPersistedStateJson,
  writeDataFile
} from '../persistence-test-harness'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  it('defaults absent model visibility on and preserves an explicit choice across reload', async () => {
    writeDataFile({ schemaVersion: 1, repos: [], worktreeMeta: {}, ui: {} })
    const store = await createStore()
    expect(store.getUI().showAgentModels).toBe(true)
    store.updateUI({ showAgentModels: false })
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.getUI().showAgentModels).toBe(false)
  })

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

  it('adds split-out default card properties for legacy detailed profiles', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr', 'comment']
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'jira-issue',
      'pr',
      'comment',
      'ports',
      'inline-agents',
      'host'
    ])
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('adds split-out default card properties without duplicating inline agents', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'ci',
          'issue',
          'pr',
          'comment',
          'inline-agents'
        ]
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'jira-issue',
      'pr',
      'comment',
      'ports',
      'inline-agents',
      'host'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI()._inlineAgentsDefaultedForAllUsers).toBe(true)
    expect(store.getUI()._expandedWorktreeCardPropertiesDefaulted).toBe(true)
  })

  it('derives fresh default profiles without branch', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'jira-issue',
      'pr',
      'automation',
      'cli',
      'comment',
      'ports',
      'inline-agents',
      'host'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI()._worktreeCardModeDefaulted).toBe(true)
  })

  it('adds split-out defaults even when the mode marker exists but expansion has not run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'ci', 'issue', 'pr'],
        _worktreeCardModeDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'ci',
      'issue',
      'linear-issue',
      'jira-issue',
      'pr',
      'ports',
      'inline-agents',
      'host'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
  })

  it('preserves deliberate post-migration card property opt-outs', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'pr'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _jiraIssueWorktreeCardPropertyDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'pr', 'host'])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).not.toContain('ports')
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('does not re-add branch after an explicit Default mode selection', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'issue',
          'linear-issue',
          'pr',
          'comment',
          'ports',
          'inline-agents'
        ],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).toContain('inline-agents')
  })

  it('preserves explicit Compact card properties after expansion has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'issue',
          'linear-issue',
          'pr',
          'comment',
          'ports'
        ],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _jiraIssueWorktreeCardPropertyDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'pr',
      'comment',
      'ports',
      'host'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('branch')
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('backfills jira-issue once for profiles stamped before it joined the defaults', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: [
          'status',
          'unread',
          'issue',
          'linear-issue',
          'pr',
          'ports',
          'inline-agents'
        ],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'jira-issue',
      'pr',
      'ports',
      'inline-agents',
      'host'
    ])
    expect(
      store.getUI().worktreeCardProperties?.filter((property) => property === 'jira-issue')
    ).toHaveLength(1)
    expect(store.getUI()._jiraIssueWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('preserves a deliberate jira-issue removal after the backfill has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'issue', 'linear-issue', 'pr'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _jiraIssueWorktreeCardPropertyDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual([
      'status',
      'unread',
      'issue',
      'linear-issue',
      'pr',
      'host'
    ])
    expect(store.getUI().worktreeCardProperties).not.toContain('jira-issue')
  })

  it('leaves fresh default profiles with a single jira-issue entry', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(
      store.getUI().worktreeCardProperties?.filter((property) => property === 'jira-issue')
    ).toHaveLength(1)
    expect(store.getUI()._jiraIssueWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('skips the jira-issue backfill when card properties are malformed', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: { worktreeCardProperties: 'not-an-array' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).not.toContain('jira-issue')
    expect(store.getUI()._jiraIssueWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('uses the compact preset when card properties are missing in compact mode', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread'])
    expect(store.getUI().worktreeCardProperties).not.toContain('automation')
  })

  it('preserves the current defaulted Compact preset without expanding display toggles', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true, experimentalNewWorktreeCardStyle: true },
      ui: {
        worktreeCardProperties: ['status', 'unread'],
        _worktreeCardModeDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getSettings().compactWorktreeCards).toBe(true)
    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread'])
    expect(store.getUI().worktreeCardProperties).not.toContain('ports')
    expect(store.getUI().worktreeCardProperties).not.toContain('inline-agents')
  })

  it('backfills host once for profiles stamped before it became a card property', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'pr', 'ports', 'inline-agents'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _jiraIssueWorktreeCardPropertyDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(
      store.getUI().worktreeCardProperties?.filter((property) => property === 'host')
    ).toHaveLength(1)
    expect(store.getUI()._hostWorktreeCardPropertyDefaulted).toBe(true)
  })

  it('preserves a deliberate host removal after the backfill has run', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: false },
      ui: {
        worktreeCardProperties: ['status', 'unread', 'pr'],
        _inlineAgentsDefaultedForAllUsers: true,
        _expandedWorktreeCardPropertiesDefaulted: true,
        _jiraIssueWorktreeCardPropertyDefaulted: true,
        _hostWorktreeCardPropertyDefaulted: true
      },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const store = await createStore()

    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'pr'])
    expect(store.getUI().worktreeCardProperties).not.toContain('host')
  })

  it.each([
    ['raw', ['status', 'automation']],
    ['normalized', ['status', 'unread', 'automation']]
  ] as const)(
    'migrates the old %s defaulted compact preset without automation',
    async (_, props) => {
      writeDataFile({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: {},
        settings: { compactWorktreeCards: true },
        ui: {
          worktreeCardProperties: [...props],
          _worktreeCardModeDefaulted: true
        },
        githubCache: { pr: {}, issue: {} },
        workspaceSession: {}
      })
      const store = await createStore()

      expect(store.getSettings().compactWorktreeCards).toBe(true)
      expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread'])
      expect(store.getUI().worktreeCardProperties).not.toContain('automation')
      expect(store.getUI()._worktreeCardModeDefaulted).toBe(true)
    }
  )

  // UI writes persist the normalized ['status', 'unread'] form; fresh profiles keep ['status'].
  it.each([
    ['raw', false],
    ['normalized', true]
  ])('does not rewrite a %s migrated Compact preset on reload', async (_, writeUI) => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { compactWorktreeCards: true },
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    vi.useFakeTimers()
    try {
      const store = await createStore()
      if (writeUI) {
        store.updateUI({ syncTaskStatusFromWorkspaceBoard: true })
      }
      vi.advanceTimersByTime(10_000)
      await store.waitForPendingWrite()
      await closeTestStores()
      const settled = readPersistedStateJson()
      const completeWrite = vi.spyOn(
        ProfileStateSqliteAuthority.prototype,
        'writeCompleteSerializedDomains'
      )
      const selectiveWrite = vi.spyOn(
        ProfileStateSqliteAuthority.prototype,
        'writeSerializedDomains'
      )
      const reloaded = await createStore()
      vi.advanceTimersByTime(10_000)
      await reloaded.waitForPendingWrite()
      expect(reloaded.getUI().worktreeCardProperties).toEqual(['status', 'unread'])
      expect(completeWrite).not.toHaveBeenCalled()
      expect(selectiveWrite).not.toHaveBeenCalled()
      expect(readPersistedStateJson()).toBe(settled)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
