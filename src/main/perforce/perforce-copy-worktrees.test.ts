import { win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceCopyListResult } from '../../shared/perforce/workspace-copy/workspace-copy-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  adoptCopyAtPath,
  copyWorktreePath,
  resolveWithCopyAdoption,
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
  const GAME = { ...REPO, id: 'repo-2', path: join(ROOT, 'Game'), vcs: 'perforce' } as const
  const GIT_GAME = { ...GAME, id: 'repo-3', kind: 'git' } as const
  const COPY = join(COPIES, 'copy-9', 'Game')

  function host(copies: Parameters<typeof listing>[0], overrides = {}) {
    const synced: string[] = []
    const syncCopies = vi.fn(async (repo: Repo) => {
      synced.push(repo.id)
      return listing(copies)
    })
    return { synced, syncCopies, host: { folderExists: () => true, syncCopies, ...overrides } }
  }

  it('syncs only the folder project the copy mirrors and adopts the copy it lists', async () => {
    const { synced, host: h } = host([{ name: 'copy-9', folderExists: true, clientExists: true }])
    await expect(
      adoptCopyAtPath(join(COPIES, 'copy-9', 'game'), [REPO, GAME, GIT_GAME], h)
    ).resolves.toBe(true)
    expect(synced).toEqual(['repo-2'])
  })

  it('adopts nothing when the listing has no usable copy at that folder', async () => {
    const clientGone = host([{ name: 'copy-9', folderExists: true, clientExists: false }])
    await expect(adoptCopyAtPath(COPY, [GAME], clientGone.host)).resolves.toBe(false)
    const other = host([{ name: 'copy-8', folderExists: true, clientExists: true }])
    await expect(adoptCopyAtPath(COPY, [GAME], other.host)).resolves.toBe(false)
  })

  it('runs no p4 for a missing folder, a path outside the copy layout or another host', async () => {
    const missing = host([], { folderExists: () => false })
    await expect(adoptCopyAtPath(COPY, [GAME], missing.host)).resolves.toBe(false)
    const outside = host([])
    await expect(adoptCopyAtPath(join(ROOT, 'Game'), [GAME], outside.host)).resolves.toBe(false)
    const remote = host([], { requiredHostId: 'ssh:build-box' })
    await expect(adoptCopyAtPath(COPY, [GAME], remote.host)).resolves.toBe(false)
    expect([missing, outside, remote].map((h) => h.syncCopies.mock.calls.length)).toEqual([0, 0, 0])
  })

  it('logs a failed sync and adopts nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing = host([], {
      syncCopies: async () => {
        throw new Error('p4 login expired')
      }
    })
    await expect(adoptCopyAtPath(COPY, [GAME], failing.host)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('resolveWithCopyAdoption', () => {
  const notFound = (): never => {
    throw new Error('selector_not_found')
  }

  it('adopts on a path: miss and resolves once more', async () => {
    const resolve = vi.fn<() => Promise<string>>().mockImplementationOnce(async () => notFound())
    resolve.mockResolvedValueOnce('copy row')
    const adopt = vi.fn(async () => true)
    await expect(resolveWithCopyAdoption('path:D:\\ws.wt\\c', resolve, adopt)).resolves.toBe(
      'copy row'
    )
    expect(adopt).toHaveBeenCalledWith('D:\\ws.wt\\c')
  })

  it('leaves other selectors, other errors and unadopted misses as they were', async () => {
    const adopt = vi.fn(async () => false)
    await expect(resolveWithCopyAdoption('name:c', async () => notFound(), adopt)).rejects.toThrow(
      'selector_not_found'
    )
    const ambiguous = async (): Promise<never> => {
      throw new Error('selector_ambiguous')
    }
    await expect(resolveWithCopyAdoption('path:D:\\c', ambiguous, adopt)).rejects.toThrow(
      'selector_ambiguous'
    )
    expect(adopt).not.toHaveBeenCalled()
    const resolve = vi.fn(async () => notFound())
    await expect(resolveWithCopyAdoption('path:D:\\c', resolve, adopt)).rejects.toThrow(
      'selector_not_found'
    )
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
