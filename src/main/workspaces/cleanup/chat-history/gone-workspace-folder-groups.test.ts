import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import * as folders from './deleted-workspace-folders'
import { sweepGoneWorkspaceFolderGroups } from './gone-workspace-folder-groups'

vi.mock('./deleted-workspace-folders', async (importOriginal) => {
  const real = await importOriginal<typeof folders>()
  return {
    ...real,
    listedCatalogFingerprint: vi.fn(real.listedCatalogFingerprint),
    isStillGone: vi.fn(real.isStillGone)
  }
})

// The one repo whose Orca workspace folder holds the gone worktree.
let repoPath = ''
vi.mock('../workspace-cleanup-run-evidence', () => ({
  listWorkspaceCleanupOwnedRepos: () => new Map([['repo', { id: 'repo', path: repoPath }]])
}))

function emptyStore(workspaceDir: string): RuntimeStore {
  const raw = {
    getSettings: () => ({ workspaceDir, nestWorkspaces: true, workspaceDirHistory: [] }),
    getRepos: () => [],
    getFolderWorkspaces: () => [],
    getAllWorktreeMeta: () => ({}),
    getAllWorktreeMetaForHost: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double with only the catalog reads the sweep's checks make.
  return raw as unknown as RuntimeStore
}

describe('sweepGoneWorkspaceFolderGroups', () => {
  let root = ''
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('checks a gone folder once per batch of its chats, and notices it coming back', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-gone-groups-'))
    repoPath = join(root, 'src', 'repo')
    const parent = join(root, 'workspaces', 'repo')
    mkdirSync(parent, { recursive: true })
    const gone = join(parent, 'deleted-worktree')
    const store = emptyStore(join(root, 'workspaces'))
    const folder = await folders.goneFolderOf(gone)
    const scope = {
      store,
      isEnabled: () => true,
      listed: await folders.readListedFolders(store),
      parentIds: new Set([folder!.ancestorId])
    }
    const chats = Array.from({ length: 320 }, (_, index) => ({ path: gone, chat: index }))
    vi.mocked(folders.listedCatalogFingerprint).mockClear()
    vi.mocked(folders.isStillGone).mockClear()
    let allowed = 0
    const result = await sweepGoneWorkspaceFolderGroups(
      scope,
      chats,
      async (_key, group, check) => {
        for (const _chat of group) {
          // Two checks per chat, as a chat's deletion asks before and inside its lane.
          allowed += (await check()) && (await check()) ? 1 : 0
        }
        return { deleted: allowed, failed: 0, freedBytes: 0 }
      }
    )
    expect(result.deleted).toBe(320)
    // 641 checks: one for the group, then one real check per 32 (the timer cap only adds checks).
    const checks = vi.mocked(folders.isStillGone).mock.calls.length
    expect(checks).toBeGreaterThanOrEqual(21)
    expect(checks).toBeLessThan(641 / 4)
    expect(vi.mocked(folders.listedCatalogFingerprint).mock.calls.length).toBe(checks)

    // The folder comes back: within one batch every later check says no.
    let kept = 0
    await sweepGoneWorkspaceFolderGroups(scope, chats.slice(0, 40), async (_key, group, check) => {
      mkdirSync(gone)
      for (const _chat of group) {
        kept += (await check()) ? 0 : 1
      }
      return { deleted: 0, failed: 0, freedBytes: 0 }
    })
    expect(kept).toBeGreaterThanOrEqual(40 - 32)
  })
})
