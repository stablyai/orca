// Match renderer startup: sweep hidden terminal rows unless reconnect would retain them.

import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import '../../../shared/workspace-layout/persistence/workspace-layout-profile.test-fixture'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { sweepPersistedUnattachedTerminalRows } from './tab-terminal-pane-binding-repair'

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

const rowIds = (session: WorkspaceSessionState, key = GIT_KEY): string[] =>
  (session.tabsByWorktree[key] ?? []).map((row) => row.id)

describe('load sweep: a terminal row outside the tab bar', () => {
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
})
