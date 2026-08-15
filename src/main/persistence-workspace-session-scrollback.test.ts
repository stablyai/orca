import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isTerminalLeafId, makePaneKey } from '../shared/stable-pane-id'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../shared/workspace-session-browser-history'
import {
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeTerminalTab
} from './persistence-test-harness'
import {
  TEST_LEAF_1,
  TEST_LEAF_2,
  makeSessionWithTerminalBuffers,
  makeSessionWithBrowserHistory
} from './persistence-session-fixtures'

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
  // ── GitHub Cache ───────────────────────────────────────────────────

  it('get/set GitHub cache round-trips', async () => {
    const store = await createStore()
    const cache = {
      pr: { 'owner/repo#1': { data: null, fetchedAt: 1000 } },
      issue: {}
    }
    store.setGitHubCache(cache)
    expect(store.getGitHubCache()).toEqual(cache)
  })

  // ── Workspace Session ──────────────────────────────────────────────

  it('get/set workspace session round-trips', async () => {
    const store = await createStore()
    const session = {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }
    store.setWorkspaceSession(session)
    expect(store.getWorkspaceSession()).toEqual(session)
  })

  it('patches workspace session without replacing unchanged slices', async () => {
    const store = await createStore()
    const tabsByWorktree = {
      wt1: [makeTerminalTab({ id: 'tab1', ptyId: null, worktreeId: 'wt1' })]
    }
    const terminalLayoutsByTabId = {
      tab1: { root: null, activeLeafId: null, expandedLeafId: null }
    }
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree,
      terminalLayoutsByTabId,
      activeConnectionIdsAtShutdown: ['ssh-1']
    })

    store.patchWorkspaceSession({
      activeTabId: 'tab2',
      activeConnectionIdsAtShutdown: undefined
    })

    const session = store.getWorkspaceSession()
    expect(session.activeTabId).toBe('tab2')
    expect(session.tabsByWorktree).toEqual(tabsByWorktree)
    expect(session.terminalLayoutsByTabId).toEqual(terminalLayoutsByTabId)
    expect(session.activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it('uses full normalization for structural workspace session patches', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', connectionId: null }))
    store.setWorkspaceSession({
      activeRepoId: 'local-repo',
      activeWorktreeId: 'local-repo::/worktree',
      activeTabId: 'tab-local',
      tabsByWorktree: {
        'local-repo::/worktree': [
          makeTerminalTab({
            id: 'tab-local',
            ptyId: 'pty-local',
            worktreeId: 'local-repo::/worktree'
          })
        ]
      },
      terminalLayoutsByTabId: {}
    })

    store.patchWorkspaceSession({
      terminalLayoutsByTabId: {
        'tab-local': {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          buffersByLeafId: { [TEST_LEAF_1]: 'local-scrollback' },
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-local' }
        }
      }
    })

    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['tab-local'].buffersByLeafId
    ).toBeUndefined()
  })

  it('stores remote terminal scrollback out of workspace session JSON', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', connectionId: null }))
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))

    store.setWorkspaceSession(makeSessionWithTerminalBuffers())

    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['local-tab'].ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'local-pty'
    })
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[TEST_LEAF_2]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('remote-scrollback')
  })

  it('stores terminal scrollback snapshots beside explicit profile data files', async () => {
    const profileDataDirectory = join(testState.dir, 'profiles', 'local-default')
    const profileDataFile = join(profileDataDirectory, 'orca-data.json')
    mkdirSync(profileDataDirectory, { recursive: true })

    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const store = new Store({ dataFile: profileDataFile })
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))
    const session = makeSessionWithTerminalBuffers()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: { 'remote-repo::/remote': session.tabsByWorktree['remote-repo::/remote'] },
      terminalLayoutsByTabId: { 'remote-tab': session.terminalLayoutsByTabId['remote-tab'] }
    })

    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    expect(ref).toEqual(expect.stringMatching(/^v1-[0-9a-f]{32}$/))
    expect(existsSync(join(profileDataDirectory, 'terminal-scrollback', `${ref}.bin`))).toBe(true)
    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(false)
  })

  it('reads legacy terminal scrollback snapshots for explicit profile data files', async () => {
    const profileDataDirectory = join(testState.dir, 'profiles', 'local-default')
    const profileDataFile = join(profileDataDirectory, 'orca-data.json')
    const ref = 'v1-11111111111111111111111111111111'
    const legacySnapshotDir = join(testState.dir, 'terminal-scrollback')
    mkdirSync(profileDataDirectory, { recursive: true })
    mkdirSync(legacySnapshotDir, { recursive: true })
    writeFileSync(join(legacySnapshotDir, `${ref}.bin`), 'legacy-scrollback', 'utf-8')

    vi.resetModules()
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const store = new Store({ dataFile: profileDataFile })

    expect(store.readTerminalScrollbackSnapshot(ref)).toBe('legacy-scrollback')
  })

  it('caps oversized browser history when setting workspace session', async () => {
    const store = await createStore()
    const oversizedSession = makeSessionWithBrowserHistory(500)
    const oversizedBytes = Buffer.byteLength(JSON.stringify(oversizedSession))

    store.setWorkspaceSession(oversizedSession)

    const session = store.getWorkspaceSession()
    const prunedBytes = Buffer.byteLength(JSON.stringify(session))
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
    expect(prunedBytes).toBeLessThan(oversizedBytes / 2)
  })

  it('stores maybe-remote terminal scrollback out of workspace session JSON', async () => {
    const store = await createStore()

    store.setWorkspaceSession({
      activeRepoId: 'remote-repo',
      activeWorktreeId: 'remote-repo::/remote',
      activeTabId: 'remote-tab',
      tabsByWorktree: {
        'remote-repo::/remote': [
          makeTerminalTab({
            id: 'remote-tab',
            ptyId: 'remote-pty',
            worktreeId: 'remote-repo::/remote'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'remote-tab': {
          root: { type: 'leaf', leafId: TEST_LEAF_2 },
          activeLeafId: TEST_LEAF_2,
          expandedLeafId: null,
          buffersByLeafId: { [TEST_LEAF_2]: 'maybe-remote-scrollback' }
        }
      }
    })

    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].buffersByLeafId
    ).toBeUndefined()
    expect(
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId
    ).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('maybe-remote-scrollback')
  })

  it('deletes terminal scrollback snapshot files when refs leave the workspace session', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))
    const session = makeSessionWithTerminalBuffers()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: { 'remote-repo::/remote': session.tabsByWorktree['remote-repo::/remote'] },
      terminalLayoutsByTabId: { 'remote-tab': session.terminalLayoutsByTabId['remote-tab'] }
    })
    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    expect(ref).toEqual(expect.stringMatching(/^v1-[0-9a-f]{32}$/))
    if (!ref) {
      throw new Error('expected scrollback snapshot ref')
    }
    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(true)

    store.setWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(false)
  })

  it('reads only the replay tail from oversized terminal scrollback snapshots', async () => {
    const store = await createStore()
    const ref = 'v1-00000000000000000000000000000000'
    const snapshotDir = join(testState.dir, 'terminal-scrollback')
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(
      join(snapshotDir, `${ref}.bin`),
      `stale-prefix-${'x'.repeat(TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)}tail`,
      'utf-8'
    )

    const buffer = store.readTerminalScrollbackSnapshot(ref)

    expect(buffer).toHaveLength(TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    expect(buffer?.startsWith('stale-prefix')).toBe(false)
    expect(buffer?.endsWith('tail')).toBe(true)
  })

  it('strips legacy local terminal scrollback buffers when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({ id: 'local-repo', connectionId: null }),
        makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithTerminalBuffers()
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.terminalLayoutsByTabId['local-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].buffersByLeafId).toBeUndefined()
    expect(session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId).toEqual({
      [TEST_LEAF_2]: expect.stringMatching(/^v1-[0-9a-f]{32}$/)
    })
    const ref = session.terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[TEST_LEAF_2]
    expect(ref ? store.readTerminalScrollbackSnapshot(ref) : null).toBe('remote-scrollback')
  })

  it('caps oversized legacy browser history when loading workspace session', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: makeSessionWithBrowserHistory(500)
    })

    const store = await createStore()
    const session = store.getWorkspaceSession()
    expect(session.browserUrlHistory).toHaveLength(MAX_BROWSER_HISTORY_ENTRIES)
    expect(session.browserUrlHistory?.at(-1)?.url).toBe('https://example.com/199')
  })

  it('remaps legacy SSH lease leaf ids when loading legacy workspace layouts', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'remote-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'remote-pty' }
          }
        }
      },
      sshRemotePtyLeases: [
        {
          targetId: 'ssh-1',
          ptyId: 'remote-pty',
          worktreeId: 'wt1',
          tabId: 'tab1',
          leafId: 'pane:1',
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
    const leafId = layout.root?.type === 'leaf' ? layout.root.leafId : null
    if (leafId === null) {
      throw new Error('Expected remapped leaf id')
    }
    expect(isTerminalLeafId(leafId)).toBe(true)
    expect(layout.ptyIdsByLeafId).toEqual({ [leafId]: 'remote-pty' })
    expect(store.getSshRemotePtyLeases('ssh-1')[0].leafId).toBe(leafId)
  })

  it('hydrates legacy numeric agent status cache through the pane identity migration', async () => {
    const agentHooksDir = join(testState.dir, 'agent-hooks')
    mkdirSync(agentHooksDir, { recursive: true })
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {
        activeRepoId: 'r1',
        activeWorktreeId: 'wt1',
        activeTabId: 'tab1',
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab1',
              worktreeId: 'wt1',
              title: 'Terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1,
              ptyId: 'local-pty'
            }
          ]
        },
        terminalLayoutsByTabId: {
          tab1: {
            root: { type: 'leaf', leafId: 'pane:1' },
            activeLeafId: 'pane:1',
            expandedLeafId: null,
            ptyIdsByLeafId: { 'pane:1': 'local-pty' }
          }
        }
      }
    })
    writeFileSync(
      join(agentHooksDir, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          'tab1:1': {
            paneKey: 'tab1:1',
            tabId: 'tab1',
            worktreeId: 'wt1',
            connectionId: null,
            receivedAt: Date.now(),
            stateStartedAt: Date.now() - 1000,
            payload: { state: 'working', prompt: 'legacy numeric prompt', agentType: 'claude' }
          }
        }
      }),
      'utf-8'
    )

    const store = await createStore()
    const { agentHookServer } = await import('./agent-hooks/server')
    await agentHookServer.start({ env: 'production', userDataPath: testState.dir })
    try {
      const layout = store.getWorkspaceSession().terminalLayoutsByTabId.tab1
      const leafId = layout.root?.type === 'leaf' ? layout.root.leafId : null
      if (leafId === null) {
        throw new Error('Expected remapped leaf id')
      }
      const stablePaneKey = makePaneKey('tab1', leafId)
      expect(agentHookServer.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: stablePaneKey,
          tabId: 'tab1',
          worktreeId: 'wt1',
          state: 'working',
          prompt: 'legacy numeric prompt',
          agentType: 'claude'
        })
      ])
    } finally {
      agentHookServer.stop()
    }
  })
})
