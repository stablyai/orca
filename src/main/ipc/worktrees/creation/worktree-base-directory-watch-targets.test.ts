import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

const { readFileMock, realpathMock, statMock, wslHomeMock, wslHomeAsyncMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  realpathMock: vi.fn(),
  statMock: vi.fn(),
  wslHomeMock: vi.fn((): string | null => null),
  wslHomeAsyncMock: vi.fn(async (): Promise<string | null> => null)
}))

vi.mock('../../../wsl/discovery/distro-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWslHome: wslHomeMock,
  getWslHomeAsync: wslHomeAsyncMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  realpath: realpathMock,
  stat: statMock
}))
import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings
} from './worktree-base-directory-watch-targets'

const absolutePath = (...parts: string[]): string => join(sep, ...parts)
const WORKTREE_ROOT = absolutePath('workspace', 'worktrees')
const PROJECT_ROOT = absolutePath('workspace', 'projects')
const localDirectoryStat = { isDirectory: () => true }
const settings = {
  workspaceDir: WORKTREE_ROOT,
  nestWorkspaces: true
} as GlobalSettings

function makeRepo(index: number, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `repo-${index}`,
    path: join(PROJECT_ROOT, `project-${index}`),
    displayName: `Project ${index}`,
    badgeColor: '#000000',
    addedAt: index,
    ...overrides
  }
}

function makeStore(repos: Repo[]) {
  return {
    getSettings: () => settings,
    getRepos: () => repos
  }
}

describe('worktree base directory watch target resolution', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    statMock.mockReset().mockResolvedValue(localDirectoryStat)
    realpathMock.mockReset().mockImplementation(async (path: string) => path)
    readFileMock.mockReset().mockResolvedValue('')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    clearWorktreeBaseDirectoryWatchTargetWarnings()
    warnSpy.mockRestore()
  })

  // Real host (win-lowspec): the synchronous probe blocked main 5 s on a cold distro and killed its boot.

  // WSL-mirrored worktrees can have Windows Git metadata; UNC root refusal must preserve that watcher.
  it('keeps the Windows-side git-common watcher when only the workspace root is a WSL UNC path', async () => {
    const repo = makeRepo(0, {
      path: 'C:\\Users\\alice\\orca',
      worktreeBasePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\workspaces'
    })

    const targets = await buildWorktreeBaseDirectoryWatchTargets(makeStore([repo]) as never)

    expect([...targets.values()].map((target) => target.kind)).toEqual(['git-common'])
    expect([...targets.values()][0]?.path).toBe('C:/Users/alice/orca/.git')
  })
})
