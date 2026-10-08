import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  createNativeChatVisualsWorkspaceVerdicts,
  readNativeChatVisualsWorkspaceCatalogs,
  type NativeChatVisualsFilesystem,
  type NativeChatVisualsWorkspaceCatalogs
} from './native-chat-visuals-workspace-verdict'

const REPO_PATH = '/work/repo-1'
const WORKTREE_PATH = '/work/repo-1-feature'
const WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

function catalogs(
  options: {
    repos?: string[]
    meta?: string[]
    folders?: string[]
    others?: Partial<NativeChatVisualsWorkspaceCatalogs['others']>
  } = {}
): NativeChatVisualsWorkspaceCatalogs {
  return {
    active: {
      getRepo: (id: string) =>
        (options.repos ?? ['repo-1']).includes(id) ? { path: REPO_PATH } : undefined,
      getAllWorktreeMeta: () => Object.fromEntries((options.meta ?? []).map((id) => [id, {}])),
      getFolderWorkspaces: () => (options.folders ?? []).map((id) => ({ id }))
    },
    others: { ids: new Set(), repoIds: new Set(), unreadableProfiles: 0, ...options.others }
  }
}

const at = (
  workspaceId: string,
  overrides: Partial<AgentSessionExecutionLocation> = {}
): AgentSessionExecutionLocation => ({
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId,
  workspaceKind: 'git-worktree',
  ...overrides
})

type Presence = 'present' | 'absent' | 'unknown'

function verdictWith(
  known: NativeChatVisualsWorkspaceCatalogs | null,
  paths: Record<string, Presence> = {},
  gitRecords: boolean | null = false
) {
  const fs: NativeChatVisualsFilesystem = {
    presence: vi.fn(async (path: string): Promise<Presence> => paths[path] ?? 'present'),
    gitRecordsWorktree: vi.fn(async () => gitRecords)
  }
  return { verdict: createNativeChatVisualsWorkspaceVerdicts(() => known, fs)(), fs }
}

describe('whether a chat workspace is provably removed', () => {
  it('is removed when its project was removed from Orca in every profile', async () => {
    const { verdict, fs } = verdictWith(catalogs({ repos: [] }))
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('removed')
    expect(fs.presence).not.toHaveBeenCalled()
  })

  it("keeps a chat whose project or folder only another profile holds (chats are shared, catalogs aren't)", async () => {
    const { verdict } = verdictWith(
      catalogs({
        repos: [],
        others: { repoIds: new Set(['repo-1']), ids: new Set(['folder:f-2']) }
      })
    )
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('unverifiable')
    await expect(verdict(at('folder:f-2', { workspaceKind: 'folder' }))).resolves.toBe('present')
  })

  it('decides nothing while any profile cannot be read', async () => {
    const { verdict } = verdictWith(catalogs({ repos: [], others: { unreadableProfiles: 1 } }))
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('unverifiable')
    await expect(verdict(at('folder:gone', { workspaceKind: 'folder' }))).resolves.toBe(
      'unverifiable'
    )
  })

  it('is present while any profile still tracks the worktree', async () => {
    for (const known of [
      catalogs({ meta: [WORKTREE_ID] }),
      catalogs({ others: { ids: new Set([WORKTREE_ID]) } })
    ]) {
      const { verdict, fs } = verdictWith(known, { [WORKTREE_PATH]: 'absent' })
      await expect(verdict(at(WORKTREE_ID))).resolves.toBe('present')
      expect(fs.presence).not.toHaveBeenCalled()
    }
  })

  it('is removed when the worktree folder is gone and git no longer records it', async () => {
    const { verdict, fs } = verdictWith(catalogs(), { [WORKTREE_PATH]: 'absent' }, false)
    await expect(verdict(at(WORKTREE_ID))).resolves.toBe('removed')
    expect(fs.gitRecordsWorktree).toHaveBeenCalledWith(REPO_PATH, WORKTREE_PATH)
  })

  it('keeps a worktree on an unmounted drive: git still records it, or the project is unreachable', async () => {
    await expect(
      verdictWith(catalogs(), { [WORKTREE_PATH]: 'absent' }, true).verdict(at(WORKTREE_ID))
    ).resolves.toBe('unverifiable')
    await expect(
      verdictWith(catalogs(), { [WORKTREE_PATH]: 'absent' }, null).verdict(at(WORKTREE_ID))
    ).resolves.toBe('unverifiable')
    await expect(
      verdictWith(catalogs(), { [WORKTREE_PATH]: 'absent', [REPO_PATH]: 'absent' }).verdict(
        at(WORKTREE_ID)
      )
    ).resolves.toBe('unverifiable')
  })

  it("never removes the project's own checkout while the project is known", async () => {
    const { verdict } = verdictWith(catalogs(), { [REPO_PATH]: 'absent' })
    await expect(verdict(at(`repo-1::${REPO_PATH}`))).resolves.toBe('unverifiable')
  })

  it('keeps a worktree whose folder is there or unreadable', async () => {
    await expect(verdictWith(catalogs()).verdict(at(WORKTREE_ID))).resolves.toBe('present')
    await expect(
      verdictWith(catalogs(), { [WORKTREE_PATH]: 'unknown' }).verdict(at(WORKTREE_ID))
    ).resolves.toBe('unverifiable')
  })

  it('reads a folder workspace from every catalog', async () => {
    const folder = (id: string) => at(`folder:${id}`, { workspaceKind: 'folder' })
    const { verdict } = verdictWith(catalogs({ folders: ['f-1'] }))
    await expect(verdict(folder('f-1'))).resolves.toBe('present')
    await expect(verdict(folder('f-2'))).resolves.toBe('removed')
  })

  it('never decides for another host, a WSL distro, the floating workspace, or without catalogs', async () => {
    const { verdict, fs } = verdictWith(catalogs({ repos: [] }))
    await expect(verdict(at(WORKTREE_ID, { executionHostId: 'ssh:box' }))).resolves.toBe(
      'unverifiable'
    )
    await expect(verdict(at(WORKTREE_ID, { wslDistro: 'Ubuntu' }))).resolves.toBe('unverifiable')
    await expect(
      verdict(at(FLOATING_TERMINAL_WORKTREE_ID, { workspaceKind: 'folder' }))
    ).resolves.toBe('unverifiable')
    await expect(verdictWith(null).verdict(at(WORKTREE_ID))).resolves.toBe('unverifiable')
    expect(fs.presence).not.toHaveBeenCalled()
  })

  it('reads the catalogs once per run, however many chats it judges', async () => {
    const read = vi.fn(() => catalogs({ repos: [] }))
    const verdict = createNativeChatVisualsWorkspaceVerdicts(read)()
    await verdict(at(WORKTREE_ID))
    await verdict(at('repo-1::/work/other'))
    expect(read).toHaveBeenCalledOnce()
  })
})

describe("git's own record of a linked worktree", () => {
  const scratch: string[] = []
  afterEach(() => {
    for (const dir of scratch.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function repoWithWorktreeRecord(recordedWorktree: string | null): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orca-visuals-git-')))
    scratch.push(repo)
    mkdirSync(join(repo, '.git', 'worktrees', 'feature'), { recursive: true })
    if (recordedWorktree) {
      writeFileSync(
        join(repo, '.git', 'worktrees', 'feature', 'gitdir'),
        `${recordedWorktree}/.git\n`
      )
    }
    return repo
  }

  it('removes only a worktree git no longer records', async () => {
    const gone = join(tmpdir(), 'orca-visuals-missing-worktree-a')
    const verdicts = (repo: string) =>
      createNativeChatVisualsWorkspaceVerdicts(() => ({
        ...catalogs(),
        active: {
          ...catalogs().active,
          getRepo: () => ({ path: repo })
        }
      }))()
    const recorded = repoWithWorktreeRecord(gone)
    await expect(verdicts(recorded)(at(`repo-1::${gone}`))).resolves.toBe('unverifiable')
    const pruned = repoWithWorktreeRecord(null)
    await expect(verdicts(pruned)(at(`repo-1::${gone}`))).resolves.toBe('removed')
  })

  it('reads a record git wrote relative to its own folder', async () => {
    const repo = repoWithWorktreeRecord(null)
    const worktree = join(repo, '..', 'orca-visuals-relative-worktree-b')
    writeFileSync(
      join(repo, '.git', 'worktrees', 'feature', 'gitdir'),
      '../../../../orca-visuals-relative-worktree-b/.git\n'
    )
    const verdict = createNativeChatVisualsWorkspaceVerdicts(() => ({
      ...catalogs(),
      active: { ...catalogs().active, getRepo: () => ({ path: repo }) }
    }))()
    await expect(verdict(at(`repo-1::${worktree}`))).resolves.toBe('unverifiable')
  })

  it('resolves a relative record against the real path when the project was added through a link', async () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'orca-visuals-real-')))
    scratch.push(real)
    const nested = join(real, 'a', 'b', 'c')
    mkdirSync(join(nested, 'repo', '.git', 'worktrees', 'wt'), { recursive: true })
    const linkedParent = join(real, 'deep')
    symlinkSync(nested, linkedParent)
    const worktree = join(real, 'wts', 'wt')
    // What git writes: relative from the record folder's real path.
    writeFileSync(
      join(nested, 'repo', '.git', 'worktrees', 'wt', 'gitdir'),
      '../../../../../../../wts/wt/.git\n'
    )
    const verdict = createNativeChatVisualsWorkspaceVerdicts(() => ({
      ...catalogs(),
      active: { ...catalogs().active, getRepo: () => ({ path: join(linkedParent, 'repo') }) }
    }))()
    await expect(verdict(at(`repo-1::${worktree}`))).resolves.toBe('unverifiable')
  })
})

describe('reading the catalogs for a sweep run', () => {
  it('skips the running profile named by its own storage folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-visuals-profiles-'))
    try {
      mkdirSync(join(root, 'profiles', 'running'), { recursive: true })
      mkdirSync(join(root, 'profiles', 'next'), { recursive: true })
      const profile = (id: string) => ({
        id,
        name: id,
        kind: 'local',
        createdAt: 0,
        updatedAt: 0,
        lastOpenedAt: 0,
        avatar: { kind: 'initials', initials: id.slice(0, 2), color: 'neutral' }
      })
      // A switch already named the next profile active; this process still runs the old one.
      writeFileSync(
        join(root, 'orca-profile-index.json'),
        JSON.stringify({ activeProfileId: 'next', profiles: [profile('running'), profile('next')] })
      )
      for (const id of ['running', 'next']) {
        writeFileSync(
          join(root, 'profiles', id, 'orca-data.json'),
          JSON.stringify({ repos: [{ id: `repo-${id}` }] })
        )
      }
      const read = readNativeChatVisualsWorkspaceCatalogs(
        {
          ...catalogs().active,
          getProfileStorageDirectory: () => join(root, 'profiles', 'running')
        },
        root
      )
      expect([...read.others.repoIds]).toEqual(['repo-next'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
