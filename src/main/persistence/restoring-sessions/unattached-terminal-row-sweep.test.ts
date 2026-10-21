// A stored terminal row with no tab-bar entry: main's load sweeps it once, as the window's startup
// does, unless the window's reconnect plan would reattach it; main's layout then never draws an
// empty extra terminal tab the window would not show.

import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sleepingRecord } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { sweepPersistedUnattachedTerminalRows } from './tab-terminal-pane-binding-repair'

const CLI_KEY = 'repo-1::/Users/dev/orca-cli'

/** tab-a in the tab bar; tab-b only as a row, bound to nothing. */
function unattachedRow(): WorkspaceSessionState {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: [
        { id: 'tab-a', leaves: [[leaf(1), 'pty-a']] },
        { id: 'tab-b', leaves: [[leaf(2)]] }
      ]
    }
  ])
  session.unifiedTabs![GIT_KEY] = session.unifiedTabs![GIT_KEY]!.filter((tab) => tab.id !== 'tab-b')
  session.tabGroups![GIT_KEY]![0]!.tabOrder = ['tab-a']
  return session
}

function swept(session: WorkspaceSessionState): WorkspaceSessionState {
  const state = getDefaultPersistedState('/home/dev')
  state.workspaceSession = session
  return sweepPersistedUnattachedTerminalRows(state).workspaceSession
}

const rowIds = (session: WorkspaceSessionState, key = GIT_KEY): string[] =>
  (session.tabsByWorktree[key] ?? []).map((row) => row.id)

describe('load sweep: a terminal row outside the tab bar', () => {
  it('goes with its pane layout when nothing would reattach it', () => {
    const session = swept(unattachedRow())
    expect(rowIds(session)).toEqual(['tab-a'])
    expect(session.terminalLayoutsByTabId['tab-b']).toBeUndefined()
  })

  it('goes when only a pane binds a terminal, as the window does', () => {
    const session = unattachedRow()
    session.terminalLayoutsByTabId['tab-b']!.ptyIdsByLeafId = { [leaf(2)]: 'pty-b' }
    expect(rowIds(swept(session))).toEqual(['tab-a'])
  })

  it('goes when its workspace was not live at shutdown', () => {
    const session = unattachedRow()
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    session.activeWorktreeIdsOnShutdown = []
    expect(rowIds(swept(session))).toEqual(['tab-a'])
  })

  it('leaves its sleeping agent record in place, as the window does', () => {
    const session = unattachedRow()
    const paneKey = `tab-b:${leaf(2)}`
    session.sleepingAgentSessionsByPaneKey = {
      [paneKey]: sleepingRecord(GIT_KEY, 'tab-b', leaf(2))
    }
    const after = swept(session)
    expect(rowIds(after)).toEqual(['tab-a'])
    expect(Object.keys(after.sleepingAgentSessionsByPaneKey ?? {})).toEqual([paneKey])
  })

  it('moves selections off it: the workspace to its first kept row, the global one to none', () => {
    const session = unattachedRow()
    session.activeTabId = 'tab-b'
    session.activeTabIdByWorktree = { [GIT_KEY]: 'tab-b' }
    const after = swept(session)
    expect(after.activeTabIdByWorktree).toEqual({ [GIT_KEY]: 'tab-a' })
    expect(after.activeTabId).toBeNull()
  })

  it('stays when its own terminal would reattach', () => {
    const session = unattachedRow()
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    expect(swept(session)).toBe(session)
  })

  it('stays when its terminal is on an SSH relay', () => {
    const session = unattachedRow()
    session.remoteSessionIdsByTabId = { 'tab-b': 'relay-b' }
    expect(swept(session)).toBe(session)
  })

  it('stays when a split row keeps its own pane’s terminal after the tab bar takes the shared one', () => {
    const session = unattachedRow()
    session.terminalLayoutsByTabId['tab-b'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: leaf(2) },
        second: { type: 'leaf', leafId: leaf(3) }
      },
      activeLeafId: leaf(2),
      expandedLeafId: null,
      ptyIdsByLeafId: { [leaf(2)]: 'pty-a', [leaf(3)]: 'pty-c' }
    }
    expect(swept(session)).toBe(session)
  })

  it('stays when the CLI started it in a workspace the window never opened', () => {
    const session = unattachedRow()
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    session.tabsByWorktree[CLI_KEY] = [
      {
        ...session.tabsByWorktree[GIT_KEY]![1]!,
        id: 'tab-cli',
        worktreeId: CLI_KEY,
        ptyId: 'pty-cli'
      }
    ]
    expect(swept(session)).toBe(session)
  })

  it('sweeps SSH partitions too and passes a paired server’s through', () => {
    const state = getDefaultPersistedState('/home/dev')
    const sshHost = toSshExecutionHostId('box')
    const serverHost = toRuntimeExecutionHostId('env-1')
    const serverSession = unattachedRow()
    state.workspaceSessionsByHostId = { [sshHost]: unattachedRow(), [serverHost]: serverSession }
    const after = sweepPersistedUnattachedTerminalRows(state).workspaceSessionsByHostId!
    expect(rowIds(after[sshHost]!)).toEqual(['tab-a'])
    expect(after[serverHost]).toBe(serverSession)
  })

  it('stays when it is an SSH workspace’s and only its own terminal id names one, as the window may reattach it', () => {
    const state = getDefaultPersistedState('/home/dev')
    state.repos = [
      {
        id: 'repo-1',
        path: '/Users/dev/orca',
        displayName: 'orca',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'box'
      }
    ]
    const session = unattachedRow()
    session.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    state.workspaceSession = session
    expect(rowIds(sweepPersistedUnattachedTerminalRows(state).workspaceSession)).toEqual([
      'tab-a',
      'tab-b'
    ])
  })

  it('stays when another partition’s stale shutdown list names its workspace, as the merged list does', () => {
    const state = getDefaultPersistedState('/home/dev')
    const sshHost = toSshExecutionHostId('box')
    const local = unattachedRow()
    local.tabsByWorktree[GIT_KEY]![1]!.ptyId = 'pty-b'
    local.activeWorktreeIdsOnShutdown = []
    const remote = emptySession()
    remote.activeWorktreeIdsOnShutdown = [GIT_KEY]
    state.workspaceSession = local
    state.workspaceSessionsByHostId = { [sshHost]: remote }
    expect(sweepPersistedUnattachedTerminalRows(state).workspaceSession).toBe(local)
  })

  it('treats a session from before the tab bar as the window does: keeps a live row, sweeps the rest', () => {
    const session = unattachedRow()
    delete session.unifiedTabs
    delete session.tabGroups
    delete session.tabGroupLayouts
    const after = swept(session)
    expect(rowIds(after)).toEqual(['tab-a'])
    expect(after.terminalLayoutsByTabId['tab-a']).toBeDefined()
  })
})
