// Recover tab-only terminal bindings before panes mount so main's frames and saves retain them.

import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf,
  SSH_KEY
} from '../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import {
  bindPersistedTabTerminalPanes,
  bindTabTerminalPanesInSession
} from './tab-terminal-pane-binding-repair'

const SSH_HOST = toSshExecutionHostId('box')

function tabLevelSession(
  key: string,
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID,
  leafIds: string[] = [leaf(1)]
): WorkspaceSessionState {
  const session = addWorkspace(
    emptySession(),
    key,
    [{ id: 'g1', tabs: [{ id: 'tab-a', leaves: leafIds.map((id): [string] => [id]) }] }],
    hostId
  )
  session.tabsByWorktree[key]![0]!.ptyId = 'pty-a'
  session.activeWorktreeIdsOnShutdown = [key]
  return session
}

const repair = (session: WorkspaceSessionState, ssh = false) =>
  bindTabTerminalPanesInSession(session, () => ssh)

const bindings = (session: WorkspaceSessionState, tabId = 'tab-a') =>
  session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId

describe("load repair: a tab's own terminal and its unbound pane", () => {
  it("binds an SSH tab's relay session id, never its row's id, as reconnect does", () => {
    const stored = tabLevelSession(SSH_KEY, SSH_HOST)
    expect(repair(stored, true)).toBe(stored)
    stored.remoteSessionIdsByTabId = { 'tab-a': 'ssh:box@@pty-9' }
    expect(bindings(repair(stored, true))).toEqual({ [leaf(1)]: 'ssh:box@@pty-9' })
  })

  it('binds one of two tabs naming the same terminal, never both', () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'g1',
        tabs: [
          { id: 'tab-a', leaves: [[leaf(1)]] },
          { id: 'tab-b', leaves: [[leaf(2)]] }
        ]
      }
    ])
    for (const row of stored.tabsByWorktree[GIT_KEY]!) {
      row.ptyId = 'pty-a'
    }
    stored.activeWorktreeIdsOnShutdown = [GIT_KEY]
    const repaired = repair(stored)
    expect(bindings(repaired, 'tab-a')).toEqual({ [leaf(1)]: 'pty-a' })
    expect(bindings(repaired, 'tab-b')?.[leaf(2)]).toBeUndefined()
  })

  it("skips a legacy row's terminal a tab-bar tab holds, and binds the row's own (#10486)", () => {
    const stored = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'tab-b', leaves: [[leaf(2)]] }] }
    ])
    stored.tabsByWorktree[GIT_KEY]![0]!.ptyId = 'pty-shared'
    // Hidden row shares one tab-bar terminal and names a separate terminal of its own.
    stored.tabsByWorktree[GIT_KEY]!.push({
      ...stored.tabsByWorktree[GIT_KEY]![0]!,
      id: 'tab-a',
      ptyId: 'pty-own',
      sortOrder: 1
    })
    stored.remoteSessionIdsByTabId = { 'tab-a': 'pty-shared' }
    stored.terminalLayoutsByTabId['tab-a'] = {
      root: { type: 'leaf', leafId: leaf(1) },
      activeLeafId: leaf(1),
      expandedLeafId: null
    }
    stored.activeWorktreeIdsOnShutdown = [GIT_KEY]
    const repaired = repair(stored)
    expect(bindings(repaired, 'tab-b')).toEqual({ [leaf(2)]: 'pty-shared' })
    expect(bindings(repaired, 'tab-a')).toEqual({ [leaf(1)]: 'pty-own' })
  })

  it("takes only the relay id for an SSH repo's workspace stored in the local partition", () => {
    const state = getDefaultPersistedState('/home/dev')
    state.repos = [
      {
        id: 'repo-ssh',
        path: '/home/dev/api',
        displayName: 'api',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'box'
      }
    ]
    state.workspaceSession = tabLevelSession(SSH_KEY)
    const local = tabLevelSession(GIT_KEY)
    local.tabsByWorktree[GIT_KEY]![0]!.id = 'tab-g'
    local.terminalLayoutsByTabId['tab-g'] = local.terminalLayoutsByTabId['tab-a']!
    state.workspaceSession.tabsByWorktree[GIT_KEY] = local.tabsByWorktree[GIT_KEY]!
    state.workspaceSession.terminalLayoutsByTabId['tab-g'] = {
      ...local.terminalLayoutsByTabId['tab-g'],
      root: { type: 'leaf', leafId: leaf(2) },
      activeLeafId: leaf(2)
    }
    state.workspaceSession.tabsByWorktree[GIT_KEY]![0]!.ptyId = 'pty-g'
    state.workspaceSession.activeWorktreeIdsOnShutdown = [SSH_KEY, GIT_KEY]
    const repaired = bindPersistedTabTerminalPanes(state).workspaceSession
    expect(bindings(repaired)?.[leaf(1)]).toBeUndefined()
    expect(bindings(repaired, 'tab-g')).toEqual({ [leaf(2)]: 'pty-g' })
  })
})
