import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { removeWorkspaceSessionOwner } from './session-owner-removal'

const REMOVED_OWNER_KEY = 'repo-1::/tmp/worktree-a'
const RETAINED_OWNER_KEY = 'repo-1::/tmp/worktree-b'

describe('deleting a workspace owner session fields', () => {
  // Why not in the table above: this map also holds host-qualified keys, so it is scanned rather
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

    expect(
      removeWorkspaceSessionOwner(session, REMOVED_OWNER_KEY)?.lastVisitedAtByWorktreeId
    ).toEqual({
      [RETAINED_OWNER_KEY]: 3,
      [`ssh:user@host|${RETAINED_OWNER_KEY}`]: 4
    })
  })
})
