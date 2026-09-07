/**
 * Global session fields live in the 'local' slice. Copies of them inside a non-local host partition
 * are legacy residue: the split never writes them there and the merge never reads them from there
 * unless local has nothing. These tests pin the drop to exactly that condition, keep the renderer's
 * merge landing on the same value either way, and re-check the two safety gates that decide which
 * global fields may be dropped at all.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'
import type { WorkspaceDocHistoryEntry } from '../../../shared/workspace-doc-history'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS,
  WORKSPACE_SESSION_FIELD_OWNERSHIP
} from '../../../shared/workspace-session-host-field-ownership'
import { WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND } from '../restoring-sessions/session-worktree-ownership'
import { parseWorkspaceSessionsByHostId } from './workspace-session-partitions'

const HOST = 'ssh:target-1'

function history(url: string): BrowserHistoryEntry[] {
  return [{ url, normalizedUrl: url, title: url, lastVisitedAt: 1, visitCount: 1 }]
}

function docEntry(filePath: string): WorkspaceDocHistoryEntry {
  return {
    docLocation: { kind: 'workspace-doc', worktreeId: 'repo-1::/tmp/a', filePath },
    title: filePath,
    lastVisitedAt: 2,
    visitCount: 1
  }
}

function localSession(overrides: Partial<WorkspaceSessionState>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), ...overrides }
}

function parse(
  raw: Record<string, unknown>,
  local?: WorkspaceSessionState
): Partial<Record<string, WorkspaceSessionState>> {
  return parseWorkspaceSessionsByHostId(raw, getDefaultWorkspaceSession(), local).partitions
}

describe('HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS', () => {
  it('only lists fields that are global AND that no worktree-ownership pass follows', () => {
    for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
      // Gate 1: the renderer's split/merge treat it as local-owned, so a non-local copy is dead.
      expect(WORKSPACE_SESSION_FIELD_OWNERSHIP[field]).toBe('global')
      // Gate 2: `collectPersistedSessionWorktreeOwners` and the deregistered-repo residue sweep
      // walk EVERY partition through this table. Anything but 'none' means dropping the field
      // could un-own a worktree and get its metadata pruned.
      expect(WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND[field]).toBe('none')
    }
  })
})

describe('parseWorkspaceSessionsByHostId global-field residue', () => {
  it('drops a non-local global field the local slice already owns', () => {
    const local = localSession({ browserUrlHistory: history('https://local.test') })
    const partitions = parse(
      {
        [HOST]: {
          ...getDefaultWorkspaceSession(),
          browserUrlHistory: history('https://stale.test')
        }
      },
      local
    )
    // Back to the default from the spread, not the 65 KB stale replica. The merge reads this field
    // from local whenever local has it, so the renderer still sees `https://local.test`
    // (`workspace-session-host-split.test.ts` pins that half of the contract).
    expect(partitions[HOST]?.browserUrlHistory).toEqual([])
  })

  it('retains a non-local global field the local slice does NOT have', () => {
    // `workspaceDocHistory` is optional and absent from the defaults, so local can genuinely lack
    // it and the merge's fallback to another slice is live.
    const local = localSession({})
    expect(local.workspaceDocHistory).toBeUndefined()
    const docs = [docEntry('/repo/remote.md')]
    const partitions = parse(
      { [HOST]: { ...getDefaultWorkspaceSession(), workspaceDocHistory: docs } },
      local
    )
    // Retained, so the merge's "fall back to any slice that has it" path still finds a value.
    expect(partitions[HOST]?.workspaceDocHistory).toEqual(docs)
  })

  it('drops that same field once the local slice does have it', () => {
    const localDocs = [docEntry('/repo/local.md')]
    const local = localSession({ workspaceDocHistory: localDocs })
    const partitions = parse(
      {
        [HOST]: {
          ...getDefaultWorkspaceSession(),
          workspaceDocHistory: [docEntry('/repo/stale.md')]
        }
      },
      local
    )
    expect(partitions[HOST]).not.toHaveProperty('workspaceDocHistory')
    expect(local.workspaceDocHistory).toEqual(localDocs)
  })

  it('leaves worktree-referencing globals and host-owned fields alone', () => {
    const local = localSession({
      browserUrlHistory: history('https://local.test'),
      activeWorktreeId: 'repo-1::/tmp/local',
      activeTabId: 'local-tab'
    })
    const tabs = { 'repo-1::/tmp/a': [] }
    const partitions = parse(
      {
        [HOST]: {
          ...getDefaultWorkspaceSession(),
          // A `'direct'` worktree reference the residue sweep reads out of every partition.
          activeWorktreeId: 'repo-1::/tmp/a',
          // Read on a partition by the mobile terminal projection.
          activeTabId: 'remote-tab',
          tabsByWorktree: tabs,
          terminalTopologyRevisionByRepoId: { 'repo-1': 4 }
        }
      },
      local
    )
    expect(partitions[HOST]?.activeWorktreeId).toBe('repo-1::/tmp/a')
    expect(partitions[HOST]?.activeTabId).toBe('remote-tab')
    expect(partitions[HOST]?.tabsByWorktree).toEqual(tabs)
    expect(partitions[HOST]?.terminalTopologyRevisionByRepoId).toEqual({ 'repo-1': 4 })
  })

  it('is a no-op when no local slice is supplied', () => {
    const stale = history('https://stale.test')
    const partitions = parse({
      [HOST]: { ...getDefaultWorkspaceSession(), browserUrlHistory: stale }
    })
    expect(partitions[HOST]?.browserUrlHistory).toEqual(stale)
  })
})
