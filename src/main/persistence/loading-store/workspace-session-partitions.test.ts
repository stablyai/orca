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
      expect(WORKSPACE_SESSION_FIELD_OWNERSHIP[field]).toBe('global')
      // Worktree-owning fields cannot be dropped: every partition contributes metadata ownership.
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
    expect(partitions[HOST]?.browserUrlHistory).toEqual([])
  })

  it('retains a non-local global field the local slice does NOT have', () => {
    // Optional doc history lacks defaults; local absence keeps the remote fallback meaningful.
    const local = localSession({})
    expect(local.workspaceDocHistory).toBeUndefined()
    const docs = [docEntry('/repo/remote.md')]
    const partitions = parse(
      { [HOST]: { ...getDefaultWorkspaceSession(), workspaceDocHistory: docs } },
      local
    )
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
          activeWorktreeId: 'repo-1::/tmp/a',
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
