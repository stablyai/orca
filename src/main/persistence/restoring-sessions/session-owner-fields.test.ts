import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  deleteOwnerKeyedSessionFields,
  OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER
} from './session-owner-fields'

const REMOVED_OWNER_KEY = 'repo-1::/tmp/worktree-a'
const RETAINED_OWNER_KEY = 'repo-1::/tmp/worktree-b'

function sessionSeededWith(field: keyof WorkspaceSessionState): WorkspaceSessionState {
  const session = { ...getDefaultWorkspaceSession() } as Record<string, unknown>
  session[field] = {
    [REMOVED_OWNER_KEY]: 'removed-value',
    [RETAINED_OWNER_KEY]: 'retained-value'
  }
  return session as WorkspaceSessionState
}

describe('deleting a workspace owner session fields', () => {
  it.each(OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER)(
    'deletes %s for the removed owner and keeps its sibling',
    (field) => {
      const session = sessionSeededWith(field)

      deleteOwnerKeyedSessionFields(session, REMOVED_OWNER_KEY, new Set())

      expect((session as Record<string, unknown>)[field]).toEqual({
        [RETAINED_OWNER_KEY]: 'retained-value'
      })
    }
  )

  it('advances the repo topology revision rather than deleting it', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { 'repo-1': 4 }
    }

    deleteOwnerKeyedSessionFields(session, REMOVED_OWNER_KEY, new Set(), {
      advanceTerminalTopologyRevision: true
    })

    expect(session.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 5 })
  })

  // Why spelled out rather than derived: the cases above iterate this list, so a field quietly
  // reclassified in the census loses its delete and its test case together.
  it('deletes exactly these fields with their owner', () => {
    expect(OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER).toEqual([
      'openFilesByWorktree',
      'activeFileIdByWorktree',
      'activeBrowserTabIdByWorktree',
      'clientHostedBrowserPagesByWorktree',
      'activeTabTypeByWorktree',
      'activeTabIdByWorktree',
      'unifiedTabs',
      'tabGroups',
      'tabGroupLayouts',
      'activeGroupIdByWorktree',
      'defaultTerminalTabsAppliedByWorktreeId'
    ])
  })

  // Why not in the list above: this map also holds host-qualified keys, so it is scanned rather
  // than indexed by the owner key, and the scan is the only thing that reaches a remote row.
  it('deletes the recency entry under a bare and a host-qualified key alike', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: {
        [REMOVED_OWNER_KEY]: 1,
        [`ssh:user@host|${REMOVED_OWNER_KEY}`]: 2,
        [RETAINED_OWNER_KEY]: 3,
        [`ssh:user@host|${RETAINED_OWNER_KEY}`]: 4
      }
    }

    deleteOwnerKeyedSessionFields(session, REMOVED_OWNER_KEY, new Set())

    expect(session.lastVisitedAtByWorktreeId).toEqual({
      [RETAINED_OWNER_KEY]: 3,
      [`ssh:user@host|${RETAINED_OWNER_KEY}`]: 4
    })
  })
})
