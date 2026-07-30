import { describe, it, expect } from 'vitest'
import type { PersistedUIState, TerminalTab, WorkspaceSessionState } from '../../shared/types'
import {
  migrateUiHostScopeSshTargetId,
  migrateWorkspaceSessionSshTargetId
} from './ssh-target-id-migration'

const OLD_ID = 'ssh-1783337351840-ohabf0'
const NEW_ID = 'ssh-1783400000000-fresh1'

const makeTab = (overrides: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'tab1',
  ptyId: null,
  worktreeId: 'r1::/wt',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  ...overrides
})

const makeSession = (overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState => ({
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  ...overrides
})

describe('migrateWorkspaceSessionSshTargetId', () => {
  it('re-encodes SSH pty ids embedded in tabs, layouts, and remote session ids', () => {
    const session = makeSession({
      tabsByWorktree: {
        'r1::/wt': [
          makeTab({ id: 'tab1', ptyId: `ssh:${OLD_ID}@@pty-3` }),
          makeTab({ id: 'tab2', ptyId: 'local-pty-7' }),
          makeTab({ id: 'tab3', ptyId: `ssh:other-target@@pty-1` })
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': `ssh:${OLD_ID}@@pty-3` }
        }
      },
      remoteSessionIdsByTabId: {
        tab1: `ssh:${OLD_ID}@@pty-3`,
        tab3: `ssh:other-target@@pty-1`
      }
    })

    expect(migrateWorkspaceSessionSshTargetId(session, OLD_ID, NEW_ID)).toBe(true)

    const tabs = session.tabsByWorktree['r1::/wt']
    expect(tabs[0].ptyId).toBe(`ssh:${NEW_ID}@@pty-3`)
    // Local and other-target pty ids must be untouched.
    expect(tabs[1].ptyId).toBe('local-pty-7')
    expect(tabs[2].ptyId).toBe(`ssh:other-target@@pty-1`)
    expect(session.terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      'leaf-1': `ssh:${NEW_ID}@@pty-3`
    })
    expect(session.remoteSessionIdsByTabId).toEqual({
      tab1: `ssh:${NEW_ID}@@pty-3`,
      tab3: `ssh:other-target@@pty-1`
    })
  })

  it('replaces the old id in activeConnectionIdsAtShutdown and dedupes', () => {
    const session = makeSession({
      activeConnectionIdsAtShutdown: [OLD_ID, NEW_ID, 'ssh-unrelated']
    })

    expect(migrateWorkspaceSessionSshTargetId(session, OLD_ID, NEW_ID)).toBe(true)
    expect(session.activeConnectionIdsAtShutdown).toEqual([NEW_ID, 'ssh-unrelated'])
  })

  it('re-points sleeping agent records pinned to the old connection', () => {
    const session = makeSession({
      sleepingAgentSessionsByPaneKey: {
        'tab1:leaf-1': {
          paneKey: 'tab1:leaf-1',
          worktreeId: 'r1::/wt',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 's-1' },
          prompt: 'p',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          connectionId: OLD_ID
        }
      }
    })

    expect(migrateWorkspaceSessionSshTargetId(session, OLD_ID, NEW_ID)).toBe(true)
    expect(session.sleepingAgentSessionsByPaneKey?.['tab1:leaf-1'].connectionId).toBe(NEW_ID)
  })

  it('returns false when nothing references the old id', () => {
    const session = makeSession({
      tabsByWorktree: { 'r1::/wt': [makeTab({ ptyId: 'local-pty' })] },
      activeConnectionIdsAtShutdown: ['ssh-unrelated']
    })

    expect(migrateWorkspaceSessionSshTargetId(session, OLD_ID, NEW_ID)).toBe(false)
    expect(session.activeConnectionIdsAtShutdown).toEqual(['ssh-unrelated'])
  })
})

describe('migrateUiHostScopeSshTargetId', () => {
  const makeUi = (overrides: Partial<PersistedUIState>): PersistedUIState =>
    ({ ...overrides }) as PersistedUIState

  it('re-points scope, visible hosts, host order, and manual repo order', () => {
    const ui = makeUi({
      workspaceHostScope: `ssh:${OLD_ID}`,
      visibleWorkspaceHostIds: ['local', `ssh:${OLD_ID}`, `ssh:${NEW_ID}`],
      workspaceHostOrder: [`ssh:${OLD_ID}`, 'local'],
      manualRepoOrder: [
        { hostId: `ssh:${OLD_ID}`, repoId: 'remote-repo' },
        { hostId: `ssh:${NEW_ID}`, repoId: 'remote-repo' },
        { hostId: 'local', repoId: 'local-repo' }
      ]
    })

    expect(migrateUiHostScopeSshTargetId(ui, OLD_ID, NEW_ID)).toBe(true)
    expect(ui.workspaceHostScope).toBe(`ssh:${NEW_ID}`)
    expect(ui.visibleWorkspaceHostIds).toEqual(['local', `ssh:${NEW_ID}`])
    expect(ui.workspaceHostOrder).toEqual([`ssh:${NEW_ID}`, 'local'])
    expect(ui.manualRepoOrder).toEqual([
      { hostId: `ssh:${NEW_ID}`, repoId: 'remote-repo' },
      { hostId: 'local', repoId: 'local-repo' }
    ])
  })

  it('returns false when the old host id appears nowhere', () => {
    const ui = makeUi({
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local'],
      workspaceHostOrder: ['local'],
      manualRepoOrder: [{ hostId: 'local', repoId: 'local-repo' }]
    })

    expect(migrateUiHostScopeSshTargetId(ui, OLD_ID, NEW_ID)).toBe(false)
  })
})
