import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../shared/execution-host'
import { collectUnsupportedSessionItems } from './orcad-source-workspace-session-eligibility'
import type { OrcadMigrationSourceScope } from './orcad-source-scope'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

// `repo-1` is selected but another host registers it too, so its unqualified keys are ambiguous.
const ROWS = {
  repoIds: new Set(['repo-1']),
  folderWorkspaceKeys: new Set<string>(),
  sharedRepoIds: new Set(['repo-1'])
}
const SSH_SCOPE: OrcadMigrationSourceScope = {
  ...ROWS,
  kind: 'ssh-relay',
  targetId: 'target-1',
  targetGeneration: 1,
  hostId: toSshExecutionHostId('target-1')
}
const WSL_SCOPE: OrcadMigrationSourceScope = {
  ...ROWS,
  kind: 'local-wsl',
  targetId: null,
  targetGeneration: null,
  hostId: LOCAL_EXECUTION_HOST_ID
}

function otherPartitionWithAmbiguousRecord(): WorkspaceSessionState {
  const paneKey = 'tab-elsewhere:leaf-1'
  const record: SleepingAgentSessionRecord = {
    paneKey,
    tabId: 'tab-elsewhere',
    worktreeId: 'repo-1::/w',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1
  }
  return { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: { [paneKey]: record } }
}

describe("a session row whose owner key can't be attributed, in another host's partition", () => {
  it('leaves an SSH conversion as it was: the row is not the conversion’s', () => {
    expect(
      collectUnsupportedSessionItems(
        otherPartitionWithAmbiguousRecord(),
        SSH_SCOPE,
        false,
        new Set(),
        new Set()
      )
    ).toEqual([])
  })

  it('refuses a WSL move, since the row may be the selected project’s', () => {
    expect(
      collectUnsupportedSessionItems(
        otherPartitionWithAmbiguousRecord(),
        WSL_SCOPE,
        false,
        new Set(),
        new Set()
      )
    ).toHaveLength(1)
  })
})
