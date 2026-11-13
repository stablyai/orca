import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../../../../shared/marine-creatures'

const { runWslTranscriptFsTaskMock, getWslHomeAsyncMock } = vi.hoisted(() => ({
  runWslTranscriptFsTaskMock: vi.fn(),
  getWslHomeAsyncMock: vi.fn()
}))

vi.mock(
  '../../../native-chat/transcript-filesystem/wsl-transcript-fs-gate',
  async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    runWslTranscriptFsTask: runWslTranscriptFsTaskMock
  })
)

// Keep parseWslPath and hasCachedWslHome real for the backfill path under test.
vi.mock('../../../wsl/discovery/distro-catalog', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getWslHomeAsync: getWslHomeAsyncMock
}))

const { discoverRetiredWorktreeNames } = await import('./worktree-retirement-discovery')
await import('./worktree-name-retirement')
const { WslTranscriptFsError } =
  await import('../../../native-chat/transcript-filesystem/wsl-transcript-fs-error')

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

  // A distro-root workspace folder encodes to the root prefix `-` on the Linux side.

  // A refused permission stays refused on retry; a slow route may answer next time.
})
