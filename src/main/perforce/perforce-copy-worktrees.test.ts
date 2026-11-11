import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceCopyListResult } from '../../shared/perforce/workspace-copy/workspace-copy-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  adoptCopyAtPath,
  copyWorktreePath,
  syncCopyWorktrees,
  type CopyWorktreeStore
} from './perforce-copy-worktrees'

// A Windows host's copies follow Windows path rules on every OS.
const { join } = win32
const ROOT = 'D:\\ws'
const COPIES = `${ROOT}.wt`
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only these Repo fields.
const REPO = { id: 'repo-1', path: ROOT, kind: 'folder', displayName: 'ws' } as Repo

function memoryStore(initial: Record<string, Partial<WorktreeMeta>> = {}) {
  const meta: Record<string, Partial<WorktreeMeta>> = { ...initial }
  const store = {
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: ({ id }: HostWorktreeTarget, patch: Partial<WorktreeMeta>) => {
      meta[id] = { ...meta[id], ...patch }
      return meta[id]
    }
  }
  const forget = (id: string): void => {
    delete meta[id]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: syncCopyWorktrees reads and writes worktree meta only.
  return { meta, store: store as unknown as CopyWorktreeStore, forget }
}

function listing(
  copies: { name: string; folderExists: boolean; clientExists: boolean }[]
): WorkspaceCopyListResult {
  return {
    source: { client: 'ws_me', root: ROOT, stream: '//g/dev' },
    copiesDir: COPIES,
    serverChecked: true,
    copies: copies.map((copy) => ({
      ...copy,
      client: `ws_me_wt_${copy.name}`,
      copyRoot: join(COPIES, copy.name),
      stream: '//g/dev',
      mode: 'same-stream',
      markerExists: true,
      created: '2026-10-01T08:54:41.000Z',
      createdBy: null
    }))
  }
}

describe('syncCopyWorktrees', () => {
  it('adopts copies with a folder and a client as visible Orca workspaces', () => {
    const { meta, store, forget } = memoryStore()
    const changed = syncCopyWorktrees(
      store,
      REPO,
      listing([
        { name: 'made-by-tool', folderExists: true, clientExists: true },
        { name: 'client-gone', folderExists: true, clientExists: false },
        { name: 'folder-gone', folderExists: false, clientExists: true }
      ]),
      forget
    )
    expect(changed).toBe(true)
    const id = `repo-1::${join(COPIES, 'made-by-tool')}`
    expect(Object.keys(meta)).toEqual([id])
    expect(meta[id]).toMatchObject({
      displayName: 'made-by-tool',
      orcaCreationSource: 'desktop',
      perforceStream: '//g/dev'
    })
    expect(meta[id]?.createdAt).toBe(Date.parse('2026-10-01T08:54:41.000Z'))
  })

  it('maps a project below the client root to the same subfolder of the copy', () => {
    const repo = { ...REPO, path: join(ROOT, 'Game') }
    expect(copyWorktreePath(repo, ROOT, join(COPIES, 'copy-1'))).toBe(
      join(COPIES, 'copy-1', 'Game')
    )
    expect(copyWorktreePath(REPO, ROOT, join(COPIES, 'copy-1'))).toBe(join(COPIES, 'copy-1'))
  })

  it('follows macOS path rules for a copy on a Mac host', () => {
    const repo = { ...REPO, path: '/Users/me/ws/Game' }
    expect(copyWorktreePath(repo, '/Users/me/ws', '/Users/me/ws.wt/copy-1')).toBe(
      '/Users/me/ws.wt/copy-1/Game'
    )
  })

  it('reports no change when the sidebar already matches', () => {
    const id = `repo-1::${join(COPIES, 'copy-1')}`
    const { store, forget } = memoryStore({
      [id]: { displayName: 'copy-1', perforceStream: '//g/dev' }
    })
    expect(
      syncCopyWorktrees(
        store,
        REPO,
        listing([{ name: 'copy-1', folderExists: true, clientExists: true }]),
        forget
      )
    ).toBe(false)
  })

  it('forgets a copy whose folder is gone, but keeps one whose client is gone', () => {
    const gone = `repo-1::${join(COPIES, 'gone')}`
    const orphaned = `repo-1::${join(COPIES, 'orphaned')}`
    const { meta, store, forget } = memoryStore({
      [gone]: { displayName: 'gone' },
      [orphaned]: { displayName: 'orphaned' }
    })
    const changed = syncCopyWorktrees(
      store,
      REPO,
      listing([{ name: 'orphaned', folderExists: true, clientExists: false }]),
      forget
    )
    expect(changed).toBe(true)
    expect(Object.keys(meta)).toEqual([orphaned])
  })
})

describe('adoptCopyAtPath', () => {
  const PERFORCE = { ...REPO, vcs: 'perforce' } as const
  const GAME = { ...PERFORCE, id: 'repo-2', path: join(ROOT, 'Game') }
  const GIT_GAME = { ...GAME, id: 'repo-3', kind: 'git' } as const

  it('syncs only the folder project the copy folder mirrors', async () => {
    const synced: string[] = []
    const sync = async (repo: Repo): Promise<void> => void synced.push(repo.id)
    await expect(
      adoptCopyAtPath(join(COPIES, 'copy-9', 'game'), [REPO, PERFORCE, GAME, GIT_GAME], sync)
    ).resolves.toBe(true)
    expect(synced).toEqual(['repo-2'])
  })

  it('adopts nothing for a path outside the copy layout or a failed sync', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('p4 unreachable')
    }
    await expect(adoptCopyAtPath(join(ROOT, 'Game'), [GAME], async () => {})).resolves.toBe(false)
    await expect(adoptCopyAtPath(join(COPIES, 'copy-9', 'Game'), [GAME], failing)).resolves.toBe(
      false
    )
  })
})
