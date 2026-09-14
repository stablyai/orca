import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION } from '../../shared/client-hosted-browser-page-record'
import type { PersistedClientHostedBrowserPage } from '../../shared/client-hosted-browser-page-record'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  SESSION_FIELDS_COPIED_BY_OWNER_KEY,
  SESSION_FIELDS_PRUNED_BY_OWNER_KEY,
  WORKSPACE_SESSION_FIELD_DISPOSITION
} from './profile-project-session-field-disposition'
import { removeRepoFromWorkspaceSession } from './profile-project-session-state'
import { extractSessionForTransfer } from './profile-project-session-transfer'

const REMOVED_REPO_ID = 'repo-1'
const TRANSFER_TARGET_REPO_ID = 'repo-3'
const REMOVED_WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const RETAINED_WORKTREE_ID = 'repo-2::/tmp/worktree-b'

function clientHostedRow(worktreeId: string): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId: `page-${worktreeId}`,
    workspaceId: worktreeId,
    browserProfileId: 'profile-1',
    url: 'https://example.test/',
    title: 'Example',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

function sessionWithClientHostedRows(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeTabTypeByWorktree: {
      [REMOVED_WORKTREE_ID]: 'browser',
      [RETAINED_WORKTREE_ID]: 'browser'
    },
    clientHostedBrowserPagesByWorktree: {
      [REMOVED_WORKTREE_ID]: [clientHostedRow(REMOVED_WORKTREE_ID)],
      [RETAINED_WORKTREE_ID]: [clientHostedRow(RETAINED_WORKTREE_ID)]
    }
  }
}

describe('client-hosted rows in the repo-removal and transfer paths', () => {
  it('drops a removed repo client-hosted rows and keeps another repo', () => {
    const result = removeRepoFromWorkspaceSession(sessionWithClientHostedRows(), REMOVED_REPO_ID)

    expect(result.clientHostedBrowserPagesByWorktree).toEqual({
      [RETAINED_WORKTREE_ID]: [clientHostedRow(RETAINED_WORKTREE_ID)]
    })
    // The sibling map is the control: whatever removal does to it, it must do here too.
    expect(result.activeTabTypeByWorktree).toEqual({ [RETAINED_WORKTREE_ID]: 'browser' })
  })

  it('leaves client-hosted rows behind on transfer while a sibling map is rekeyed', () => {
    const result = extractSessionForTransfer(
      sessionWithClientHostedRows(),
      REMOVED_REPO_ID,
      TRANSFER_TARGET_REPO_ID
    )

    expect(result.activeTabTypeByWorktree).toEqual({ 'repo-3::/tmp/worktree-a': 'browser' })
    // Not an omission: the rows name a paired device and browser profile the payload cannot carry.
    expect(result.clientHostedBrowserPagesByWorktree).toBeUndefined()
  })

  it('removes the transferred repo rows from the source it left', () => {
    const source = removeRepoFromWorkspaceSession(
      sessionWithClientHostedRows(),
      REMOVED_REPO_ID
    ).clientHostedBrowserPagesByWorktree

    expect(source?.[REMOVED_WORKTREE_ID]).toBeUndefined()
  })
})

describe('workspace session field disposition census', () => {
  // Only the field under test is seeded: the owner-keyed paths care about keys, and a shared seed
  // would hand a bespoke field a value of the wrong shape.
  const ownerKeyedSeed = (field: keyof WorkspaceSessionState): WorkspaceSessionState => {
    const session = { ...getDefaultWorkspaceSession() } as Record<string, unknown>
    session[field] = {
      [REMOVED_WORKTREE_ID]: 'removed-value',
      [RETAINED_WORKTREE_ID]: 'retained-value'
    }
    return session as WorkspaceSessionState
  }

  it.each(SESSION_FIELDS_PRUNED_BY_OWNER_KEY)(
    'prunes %s for the removed repo and keeps the other repo entry',
    (field) => {
      const result = removeRepoFromWorkspaceSession(
        ownerKeyedSeed(field),
        REMOVED_REPO_ID
      ) as Record<string, unknown>

      expect(result[field]).toEqual({ [RETAINED_WORKTREE_ID]: 'retained-value' })
    }
  )

  it.each(SESSION_FIELDS_COPIED_BY_OWNER_KEY)(
    'rekeys %s onto the target repo and carries nothing else',
    (field) => {
      const result = extractSessionForTransfer(
        ownerKeyedSeed(field),
        REMOVED_REPO_ID,
        TRANSFER_TARGET_REPO_ID
      ) as Record<string, unknown>

      expect(result[field]).toEqual({ 'repo-3::/tmp/worktree-a': 'removed-value' })
    }
  )

  const notTransferredFields = (
    Object.keys(WORKSPACE_SESSION_FIELD_DISPOSITION) as (keyof WorkspaceSessionState)[]
  ).filter((field) => WORKSPACE_SESSION_FIELD_DISPOSITION[field].onTransfer === 'notTransferred')

  it.each(notTransferredFields)('leaves %s behind on transfer', (field) => {
    const session = { ...getDefaultWorkspaceSession() } as Record<string, unknown>
    session[field] = { [REMOVED_WORKTREE_ID]: 'source-only-value' }

    const result = extractSessionForTransfer(
      session as WorkspaceSessionState,
      REMOVED_REPO_ID,
      TRANSFER_TARGET_REPO_ID
    ) as Record<string, unknown>

    expect(result[field]).toEqual((getDefaultWorkspaceSession() as Record<string, unknown>)[field])
  })

  // Why spelled out rather than derived: every other test here iterates these lists, so a field
  // quietly reclassified loses its pruning and its test case together and the suite stays green.
  // Reclassifying now means editing this array, which is a reviewed change.
  it('prunes exactly these fields by owner key on repo removal', () => {
    expect(SESSION_FIELDS_PRUNED_BY_OWNER_KEY).toEqual([
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
      'lastVisitedAtByWorktreeId',
      'defaultTerminalTabsAppliedByWorktreeId',
      'terminalTopologyRevisionByRepoId'
    ])
  })

  it('copies exactly these fields by owner key on transfer', () => {
    expect(SESSION_FIELDS_COPIED_BY_OWNER_KEY).toEqual([
      'activeFileIdByWorktree',
      'activeBrowserTabIdByWorktree',
      'activeTabTypeByWorktree',
      'activeTabIdByWorktree',
      'tabGroupLayouts',
      'activeGroupIdByWorktree',
      'lastVisitedAtByWorktreeId',
      'defaultTerminalTabsAppliedByWorktreeId',
      'terminalTopologyRevisionByRepoId'
    ])
  })

  it('classifies every field a default session already carries', () => {
    const unclassified = Object.keys(getDefaultWorkspaceSession()).filter(
      (field) => !(field in WORKSPACE_SESSION_FIELD_DISPOSITION)
    )

    expect(unclassified).toEqual([])
  })
})
