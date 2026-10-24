import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

const { runWslTranscriptFsTaskMock, getWslHomeAsyncMock } = vi.hoisted(() => ({
  runWslTranscriptFsTaskMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn()
}))

vi.mock('./native-chat/wsl-transcript-fs-gate', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  runWslTranscriptFsTask: runWslTranscriptFsTaskMock
}))

// Keep parseWslPath and hasCachedWslHome real for the backfill path under test.
vi.mock('./wsl', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getWslHomeAsync: getWslHomeAsyncMock
}))

const { discoverRetiredWorktreeNames } = await import('./worktree-retirement-discovery')
const { ensureRetiredWorktreeNamesBackfilled } = await import('./worktree-name-retirement')
const { WslTranscriptFsError } = await import('./native-chat/wsl-transcript-fs-gate')

const FIRST = MARINE_CREATURES[0].toLowerCase()
const DISTRO_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca\\workspaces'

describe('retirement discovery on WSL', () => {
  beforeEach(() => {
    runWslTranscriptFsTaskMock.mockReset()
    getWslHomeAsyncMock.mockReset()
    runWslTranscriptFsTaskMock.mockImplementation(
      (_options: unknown, task: (signal: AbortSignal) => Promise<unknown>) =>
        task(new AbortController().signal)
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('admits every WSL UNC listing through the bounded filesystem gate', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    })

    // Both UNC listings and absence-proving ancestor probes must share scan admission.
    const calls = runWslTranscriptFsTaskMock.mock.calls.map(([options]) => options)
    expect(calls.every((options) => options.priority === 'scan')).toBe(true)
    expect(calls.map((options) => options.path)).toEqual(
      expect.arrayContaining([
        DISTRO_ROOT,
        join('\\\\wsl.localhost\\Ubuntu\\home\\ada', '.claude', 'projects')
      ])
    )
  })

  it('leaves no listing ungated when the workspace root is on the Windows side', async () => {
    await discoverRetiredWorktreeNames({
      workspaceRoots: ['C:\\Users\\ada\\orca\\workspaces'],
      home: '/nonexistent-home',
      env: {}
    })

    expect(runWslTranscriptFsTaskMock).not.toHaveBeenCalled()
  })

  it('reports a gate refusal as incomplete but still returns what the host side could read', async () => {
    runWslTranscriptFsTaskMock.mockRejectedValue(
      new WslTranscriptFsError('timeout', 'filesystem access is taking too long')
    )
    const hostHome = await mkdtemp(join(tmpdir(), 'orca-wsl-host-home-'))
    try {
      await mkdir(
        join(
          hostHome,
          '.claude',
          'projects',
          `--wsl-localhost-ubuntu-home-ada-orca-workspaces-${FIRST}`
        ),
        { recursive: true }
      )

      const retired = await discoverRetiredWorktreeNames({
        workspaceRoots: [DISTRO_ROOT],
        home: hostHome,
        env: {},
        resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
      })

      expect(retired.complete).toBe(false)
      expect(retired.names).toEqual(new Set([FIRST]))
    } finally {
      await rm(hostHome, { force: true, recursive: true })
    }
  })

  it('accepts a UNC ENOENT as absence once the parent directory still lists', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const distroHome = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    // Only the home exists; walking past missing intermediate directories proves the route is up.
    const missing = new Set([
      DISTRO_ROOT,
      '\\\\wsl.localhost\\Ubuntu\\home\\ada\\orca',
      join(distroHome, '.claude', 'projects'),
      join(distroHome, '.claude')
    ])
    runWslTranscriptFsTaskMock.mockImplementation((options: { path: string }) =>
      missing.has(options.path) ? Promise.reject(enoent) : Promise.resolve([])
    )

    const retired = await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => distroHome
    })

    expect(retired.complete).toBe(true)
  })

  it('does not trust a UNC ENOENT, which is what a shut-down distro looks like', async () => {
    // An unreachable 9P route returns ENOENT even while the distro home remains cached.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    runWslTranscriptFsTaskMock.mockRejectedValue(enoent)

    const retired = await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => '\\\\wsl.localhost\\Ubuntu\\home\\ada'
    })

    expect(retired.complete).toBe(false)
  })

  it('stays retryable when the distro home cannot be resolved, rather than memoizing the hole', async () => {
    const retired = await discoverRetiredWorktreeNames({
      workspaceRoots: [DISTRO_ROOT],
      home: '/nonexistent-home',
      env: {},
      resolveWslHome: async () => null
    })

    expect(retired.complete).toBe(false)
  })

  it('keeps a deleted WSL workspace name spent, so the next create cannot reuse its cwd', async () => {
    // The distro bucket outlives the deleted workspace and must keep its name retired.
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-wsl-distro-home-'))
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'orca-wsl-workspaces-'))
    try {
      await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
        recursive: true
      })

      const retired = await discoverRetiredWorktreeNames({
        // The root is listed under its real (empty) path; the UNC spelling supplies the distro.
        workspaceRoots: [DISTRO_ROOT],
        home: workspaceRoot,
        env: {},
        resolveWslHome: async () => distroHome
      })

      expect(retired.names).toEqual(new Set([FIRST]))
      expect(createRetiredNameLookup({ exhaustedTiers: 0, names: [...retired.names] })(FIRST)).toBe(
        true
      )
    } finally {
      await rm(distroHome, { force: true, recursive: true })
      await rm(workspaceRoot, { force: true, recursive: true })
    }
  })

  it('reaches distro discovery from the real backfill, not only when called directly', async () => {
    const distroHome = await mkdtemp(join(tmpdir(), 'orca-wsl-backfill-home-'))
    try {
      await mkdir(join(distroHome, '.claude', 'projects', `-home-ada-orca-workspaces-${FIRST}`), {
        recursive: true
      })
      getWslHomeAsyncMock.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\ada')
      runWslTranscriptFsTaskMock.mockImplementation(
        (options: { path: string }, task: (signal: AbortSignal) => Promise<unknown>) => {
          const claudeRoot = join('\\\\wsl.localhost\\Ubuntu\\home\\ada', '.claude', 'projects')
          return options.path === claudeRoot
            ? readdir(join(distroHome, '.claude', 'projects'), { withFileTypes: true })
            : task(new AbortController().signal)
        }
      )
      const merged: string[] = []

      await ensureRetiredWorktreeNamesBackfilled(
        {
          mergeRetiredWorktreeNames: (_repoId: string, names: Iterable<string>) => {
            merged.push(...names)
            return true
          }
        } as never,
        {
          id: 'repo-wsl',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repos\\a',
          displayName: 'a',
          badgeColor: '',
          addedAt: 0
        } as never,
        // Use a UNC root directly; parseWslPath ignores UNC repo routing off Windows.
        { workspaceDir: DISTRO_ROOT, nestWorkspaces: false }
      )

      expect(merged).toContain(FIRST)
    } finally {
      await rm(distroHome, { force: true, recursive: true })
    }
  })
})
