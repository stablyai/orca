import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const WSL_CLAUDE_PROJECTS_DIR = `${UBUNTU_HOME}\\.claude\\projects`
const WSL_CLAUDE_TRANSCRIPT = `${WSL_CLAUDE_PROJECTS_DIR}\\-home-ada-repo\\claude-wsl-sess.jsonl`
const WSL_MANAGED_SESSIONS_DIR = `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-wsl-sess.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-wsl-sess.jsonl'

vi.mock('../wsl', () => ({
  listWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  getWslHomeAsync: vi.fn(async () => UBUNTU_HOME)
}))

// Only these UNC fixtures are readable. Every other `\\wsl.localhost\` path —
// wrong distro, missing file — must reject, or the mock would mask a misresolve.
// Non-WSL paths hit the real fs, so the guest Linux path stays unreadable as on a
// real Windows host, where it would misresolve against the current drive.
const READABLE_WSL_UNC_PATHS = new Set([ROLLOUT_UNC])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromisesModule>()
  return {
    ...actual,
    access: async (path: string) => {
      if (!path.startsWith('\\\\wsl.localhost\\')) {
        await actual.access(path)
        return
      }
      if (!READABLE_WSL_UNC_PATHS.has(path)) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
    }
  }
})

const HOST_ROLLOUT = 'C:\\host\\sessions\\rollout-wsl-sess.jsonl'
const HOST_CLAUDE_TRANSCRIPT = 'C:\\host\\claude-projects\\-repo\\claude-wsl-sess.jsonl'
const scanned = vi.hoisted(() => ({
  dirs: [] as string[],
  hostClaudeHasTranscript: false,
  hostRootHasRollout: false,
  wslClaudeTranscriptDir: null as string | null
}))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: async (dir: string, agent: string) => {
    scanned.dirs.push(dir)
    const isWslRoot = dir.startsWith('\\\\wsl.localhost\\')
    if (agent === 'claude' && !isWslRoot && scanned.hostClaudeHasTranscript) {
      return [HOST_CLAUDE_TRANSCRIPT]
    }
    if (agent === 'claude' && dir === scanned.wslClaudeTranscriptDir) {
      return [WSL_CLAUDE_TRANSCRIPT]
    }
    return scanned.hostRootHasRollout && !isWslRoot
      ? ['C:\\host\\sessions\\rollout-wsl-sess.jsonl']
      : []
  }
}))

import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => (resolve = done)), resolve }
}

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  vi.mocked(getWslHomeAsync).mockClear()
  vi.mocked(listWslDistrosAsync).mockClear()
  scanned.dirs = []
  scanned.hostClaudeHasTranscript = false
  scanned.hostRootHasRollout = false
  scanned.wslClaudeTranscriptDir = null
  setPlatform('win32')
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe('resolveSessionFilePath on a Windows host with WSL', () => {
  it('routes an exact hook path through only the authoritative PTY distro', async () => {
    await expect(
      resolveSessionFilePath('codex', 'ignored', {
        transcriptPath: ROLLOUT_LINUX,
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ).resolves.toBe(ROLLOUT_UNC)

    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).not.toHaveBeenCalled()
  })

  it('does not search WSL when authoritative PTY provenance says host', async () => {
    const options = { transcriptHost: { kind: 'host' as const } }

    await expect(resolveSessionFilePath('claude', 'missing', options)).resolves.toBeNull()

    expect(scanned.dirs).toHaveLength(1)
    expect(scanned.dirs[0]).not.toMatch(/^\\\\wsl/)
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).not.toHaveBeenCalled()
  })

  it('searches only the authoritative PTY distro for a WSL Claude session', async () => {
    vi.mocked(listWslDistrosAsync).mockResolvedValueOnce(['Missing', 'Ubuntu'])
    scanned.wslClaudeTranscriptDir = WSL_CLAUDE_PROJECTS_DIR
    const options = { transcriptHost: { kind: 'wsl' as const, distro: 'Ubuntu' } }

    await expect(resolveSessionFilePath('claude', 'claude-wsl-sess', options)).resolves.toBe(
      WSL_CLAUDE_TRANSCRIPT
    )

    expect(scanned.dirs).toEqual([WSL_CLAUDE_PROJECTS_DIR])
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).toHaveBeenCalledWith('Ubuntu')
  })

  it('applies authoritative PTY routing to Codex without broad discovery', async () => {
    await expect(
      resolveSessionFilePath('codex', 'missing', {
        transcriptHost: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ).resolves.toBeNull()

    expect(scanned.dirs).toEqual([
      `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`,
      `${UBUNTU_HOME}\\.codex\\sessions`
    ])
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
  })

  it('does not search WSL for a host-owned Codex miss', async () => {
    await expect(
      resolveSessionFilePath('codex', 'missing', { transcriptHost: { kind: 'host' } })
    ).resolves.toBeNull()

    expect(scanned.dirs.some((dir) => dir.startsWith('\\\\wsl.localhost\\'))).toBe(false)
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
  })

  it.each(['grok', 'omp'] as const)(
    'does not bind a host %s transcript to a WSL-owned PTY',
    async (agent) => {
      await expect(
        resolveSessionFilePath(agent, 'same-id', {
          transcriptHost: { kind: 'wsl', distro: 'Ubuntu' }
        })
      ).resolves.toBeNull()

      expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    }
  )

  it('resolves a Claude transcript from WSL when no hook path is known', async () => {
    scanned.wslClaudeTranscriptDir = WSL_CLAUDE_PROJECTS_DIR

    await expect(resolveSessionFilePath('claude', 'claude-wsl-sess')).resolves.toBe(
      WSL_CLAUDE_TRANSCRIPT
    )
  })

  it('continues to later WSL Claude roots after a root misses', async () => {
    vi.mocked(listWslDistrosAsync).mockResolvedValueOnce(['Missing', 'Ubuntu'])
    vi.mocked(getWslHomeAsync).mockImplementation(async (distro) =>
      distro === 'Missing' ? '\\\\wsl.localhost\\Missing\\home\\ada' : UBUNTU_HOME
    )
    scanned.wslClaudeTranscriptDir = WSL_CLAUDE_PROJECTS_DIR

    await expect(resolveSessionFilePath('claude', 'claude-wsl-sess')).resolves.toBe(
      WSL_CLAUDE_TRANSCRIPT
    )
    expect(scanned.dirs).toContain('\\\\wsl.localhost\\Missing\\home\\ada\\.claude\\projects')
  })

  it('does not enumerate WSL distros when the host Claude root has the transcript', async () => {
    scanned.hostClaudeHasTranscript = true

    await expect(resolveSessionFilePath('claude', 'claude-wsl-sess')).resolves.toBe(
      HOST_CLAUDE_TRANSCRIPT
    )

    expect(scanned.dirs.some((dir) => dir.startsWith('\\\\wsl.localhost\\'))).toBe(false)
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).not.toHaveBeenCalled()
  })

  it('does not enumerate WSL distros when a Claude root override misses', async () => {
    await expect(
      resolveSessionFilePath('claude', 'missing', {
        claudeProjectsDir: 'C:\\override\\claude-projects'
      })
    ).resolves.toBeNull()

    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).not.toHaveBeenCalled()
  })

  it('honors cancellation while Claude WSL roots are loading', async () => {
    const home = deferred<string | null>()
    vi.mocked(getWslHomeAsync).mockReturnValueOnce(home.promise)
    const controller = new AbortController()
    const resolution = resolveSessionFilePath('claude', 'missing', {}, controller.signal)
    await vi.waitFor(() => expect(getWslHomeAsync).toHaveBeenCalledOnce())

    controller.abort(new Error('closed'))
    home.resolve(null)

    await expect(resolution).rejects.toThrow('closed')
  })

  it('translates a WSL hook transcript path to its host-readable UNC twin (#10326)', async () => {
    const resolved = await resolveSessionFilePath('codex', 'wsl-sess', {
      transcriptPath: ROLLOUT_LINUX,
      codexSessionsDirs: []
    })
    expect(resolved).toBe(ROLLOUT_UNC)
  })

  it('does not return a UNC twin that no distro actually has', async () => {
    const resolved = await resolveSessionFilePath('codex', 'wsl-sess', {
      transcriptPath: '/home/ada/.codex/sessions/2026/07/24/rollout-gone.jsonl',
      codexSessionsDirs: []
    })
    expect(resolved).toBeNull()
  })

  it('searches the WSL managed Codex sessions root when no hook path is known', async () => {
    await resolveSessionFilePath('codex', 'wsl-sess')
    expect(scanned.dirs).toContain(WSL_MANAGED_SESSIONS_DIR)
    expect(scanned.dirs).toContain(`${UBUNTU_HOME}\\.codex\\sessions`)
  })

  it('does not enumerate WSL distros when a host Codex root already has the rollout', async () => {
    // Why: listing WSL homes spawns wsl.exe per distro, which boots distros the
    // user deliberately left stopped. It must stay a last resort.
    scanned.hostRootHasRollout = true

    await expect(resolveSessionFilePath('codex', 'wsl-sess')).resolves.toBe(HOST_ROLLOUT)

    expect(scanned.dirs.some((dir) => dir.startsWith('\\\\wsl.localhost\\'))).toBe(false)
    expect(vi.mocked(listWslDistrosAsync)).not.toHaveBeenCalled()
    expect(vi.mocked(getWslHomeAsync)).not.toHaveBeenCalled()
  })

  it('leaves the guest path alone on non-Windows hosts', async () => {
    setPlatform('darwin')
    const resolved = await resolveSessionFilePath('codex', 'wsl-sess', {
      transcriptPath: ROLLOUT_LINUX,
      codexSessionsDirs: []
    })
    expect(resolved).toBeNull()
  })
})
