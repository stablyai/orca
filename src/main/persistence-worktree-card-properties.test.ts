import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore, writeDataFile } from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
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

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── worktree-card property migration ───────────────────────────────

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
      'inline-agents'
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
      'inline-agents'
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
      'inline-agents'
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
      'inline-agents'
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

    expect(store.getUI().worktreeCardProperties).toEqual(['status', 'unread', 'pr'])
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
      'ports'
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
      'inline-agents'
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
      'pr'
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
})
