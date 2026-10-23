// One disk move's editor renames over two partitions (a local and an SSH workspace): main writes
// both or, when either refuses, neither.

import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  SSH_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { commitLayoutCommandsAcrossPartitions } from './layout-command-commit'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const SSH: ExecutionHostId = 'ssh:target-1'

function context(): TerminalTopologyCommitContext {
  const state: Pick<
    PersistedState,
    'workspaceSession' | 'workspaceSessionsByHostId' | 'ui' | 'sshRemotePtyLeases'
  > = {
    workspaceSession: addWorkspace(emptySession(), GIT_KEY, [
      { id: 'g1', tabs: [{ id: 'd-local', entityId: 'diff::/a.ts', kind: 'diff' }] }
    ]),
    workspaceSessionsByHostId: {
      [SSH]: addWorkspace(
        emptySession(),
        SSH_KEY,
        [
          {
            id: 'g2',
            tabs: [
              { id: 'd-ssh', entityId: 'diff::/a.ts', kind: 'diff' },
              { id: 'd-ssh-b', entityId: 'diff::/b.ts', kind: 'diff' }
            ]
          }
        ],
        SSH
      )
    },
    ui: getDefaultUIState(),
    sshRemotePtyLeases: []
  }
  return {
    state,
    hostIds: () => ['local', SSH],
    getSession: (hostId) =>
      (hostId === 'local' ? undefined : state.workspaceSessionsByHostId?.[hostId]) ??
      state.workspaceSession,
    markDirty: () => {}
  }
}

const rename = (workspace: string, newFileId: string): CommandOf<'renameEditorFiles'> => ({
  type: 'renameEditorFiles',
  workspace,
  renames: [{ fileId: 'diff::/a.ts', newFileId }]
})

const entities = (commit: TerminalTopologyCommitContext, hostId: ExecutionHostId, key: string) =>
  (commit.getSession(hostId).unifiedTabs?.[key] ?? []).map((tab) => tab.entityId)

describe('editor renames across partitions', () => {
  it('writes every partition when each applies', () => {
    const commit = context()
    const result = commitLayoutCommandsAcrossPartitions(
      [
        { hostId: 'local', command: rename(GIT_KEY, 'diff::/c.ts') },
        { hostId: SSH, command: rename(SSH_KEY, 'diff::/c.ts') }
      ],
      commit
    )
    expect(result.value.ok).toBe(true)
    expect(entities(commit, 'local', GIT_KEY)).toEqual(['diff::/c.ts'])
    expect(entities(commit, SSH, SSH_KEY)).toEqual(['diff::/c.ts', 'diff::/b.ts'])
  })

  it('writes neither partition when one refuses', () => {
    const commit = context()
    const result = commitLayoutCommandsAcrossPartitions(
      [
        { hostId: 'local', command: rename(GIT_KEY, 'diff::/b.ts') },
        // b.ts is open there and not itself renamed.
        { hostId: SSH, command: rename(SSH_KEY, 'diff::/b.ts') }
      ],
      commit
    )
    expect(result).toEqual({ value: { ok: false, code: 'invalid_params' }, persist: false })
    expect(entities(commit, 'local', GIT_KEY)).toEqual(['diff::/a.ts'])
    expect(entities(commit, SSH, SSH_KEY)).toEqual(['diff::/a.ts', 'diff::/b.ts'])
  })
})
