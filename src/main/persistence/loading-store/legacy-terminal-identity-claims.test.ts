import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { LegacyTerminalIdentityClaims } from './legacy-terminal-identity-claims'
import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { preserveMissingWorkspaceSessionTerminalBindings } from './workspace-session-terminal-binding-replay'

const leaf = '11111111-1111-4111-8111-111111111111'
const workspace = 'repo::/original'
const pane = `tab-original:${leaf}`
const canonical = 'repo::/original@@fb3a1e52'
const row: TerminalTab = {
  id: 'tab-original',
  worktreeId: workspace,
  ptyId: '9',
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}
function session(id = '9'): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: { [workspace]: [{ ...row, ptyId: id }] },
    terminalLayoutsByTabId: {
      [row.id]: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: id }
      }
    }
  }
}

describe('legacy terminal identity ownership', () => {
  it('collapses same-pane mirrors, remembers competing owners through removal, and rejects shared split numbers', () => {
    const state = {
      ...getDefaultPersistedState('/tmp/claims-fixture'),
      repos: [{ id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }],
      workspaceSession: session()
    }
    const claims = new LegacyTerminalIdentityClaims(state)
    expect(claims.unique(workspace, pane, '9')).toBe(true)
    claims.observeRow(
      `worktree:${workspace}`,
      { ...row },
      state.workspaceSession.terminalLayoutsByTabId[row.id]
    )
    expect(claims.unique(workspace, pane, '9')).toBe(true)
    claims.observeBinding('repo::/other', `other:${leaf}`, '9')
    expect(claims.unique(workspace, pane, '9')).toBe(false)
    claims.observeBinding(workspace, pane, '9')
    expect(claims.unique(workspace, pane, '9')).toBe(false)
  })

  it('rebases only the surviving exact pane, retaining ambiguous old duplicates as they were', () => {
    const claims = new LegacyTerminalIdentityClaims({
      ...getDefaultPersistedState('/tmp/claims-fixture'),
      repos: [{ id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }],
      workspaceSession: session()
    })
    const incoming = session()
    const prior = session(canonical)
    const recovery = {
      getTerminalLayoutLeafIds: () => new Set([leaf]),
      getConnectionIdForWorktree: () => null,
      isRestorablePtyBinding: () => true,
      hasRestorableSshRemotePtyLease: () => false
    }
    preserveMissingWorkspaceSessionTerminalBindings(incoming, prior, recovery, {
      isLocalWorkspace: claims.isLocalWorkspace.bind(claims)
    })
    expect(incoming.terminalLayoutsByTabId[row.id].ptyIdsByLeafId?.[leaf]).toBe(canonical)
    const removed = session(canonical)
    removed.terminalLayoutsByTabId[row.id].root = null
    const stale = session()
    preserveMissingWorkspaceSessionTerminalBindings(stale, removed, recovery, {
      isLocalWorkspace: claims.isLocalWorkspace.bind(claims)
    })
    expect(stale.terminalLayoutsByTabId[row.id].ptyIdsByLeafId?.[leaf]).toBe('9')
    const duplicates = session()
    duplicates.tabsByWorktree['other::/worktree'] = [
      { ...row, id: 'other-tab', worktreeId: 'other::/worktree' }
    ]
    const shared = new LegacyTerminalIdentityClaims({
      ...getDefaultPersistedState('/tmp/claims-fixture'),
      repos: [{ id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }],
      workspaceSession: duplicates
    })
    expect(shared.unique(workspace, pane, '9')).toBe(false)
    expect(duplicates.tabsByWorktree[workspace][0].ptyId).toBe('9')
    expect(duplicates.tabsByWorktree['other::/worktree'][0].ptyId).toBe('9')
  })

  it.each([10, 100])(
    'admits %i pane claims once and answers without revisiting their saved rows',
    (count) => {
      const state = getDefaultPersistedState('/tmp/claims-fixture')
      let reads = 0
      state.repos = [
        { id: 'repo', path: '/original', displayName: 'Repo', badgeColor: '', addedAt: 1 }
      ]
      state.workspaceSession = {
        ...state.workspaceSession,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {}
      }
      for (let i = 0; i < count; i++) {
        const id = `tab-${i}`
        const saved = { ...row, id }
        Object.defineProperty(saved, 'ptyId', {
          get: () => {
            reads++
            return String(i)
          },
          enumerable: true
        })
        state.workspaceSession.tabsByWorktree[`repo::/${i}`] = [saved]
        state.workspaceSession.terminalLayoutsByTabId[id] = {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: String(i) }
        }
      }
      const claims = new LegacyTerminalIdentityClaims(state)
      expect(reads).toBeLessThanOrEqual(count)
      reads = 0
      for (let i = 0; i < count; i++) {
        expect(claims.unique(`repo::/${i}`, `tab-${i}:${leaf}`, String(i))).toBe(true)
      }
      expect(reads).toBe(0)
    }
  )
})
