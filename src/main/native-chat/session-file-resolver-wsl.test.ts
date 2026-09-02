import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type * as WslRunningPathFilterModule from '../wsl-running-path-filter'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const WSL_MANAGED_SESSIONS_DIR = `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-wsl-sess.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-wsl-sess.jsonl'

vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(async () => UBUNTU_HOME),
  listRunningWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  listRunningWslHomeDirsAsync: vi.fn(async () => [UBUNTU_HOME])
}))
vi.mock('../wsl-running-path-filter', async (importOriginal) => ({
  ...(await importOriginal<typeof WslRunningPathFilterModule>()),
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
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
const scanned = vi.hoisted(() => ({ dirs: [] as string[], hostRootHasRollout: false }))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: async (dir: string) => {
    scanned.dirs.push(dir)
    const isWslRoot = dir.startsWith('\\\\wsl.localhost\\')
    return scanned.hostRootHasRollout && !isWslRoot
      ? ['C:\\host\\sessions\\rollout-wsl-sess.jsonl']
      : []
  }
}))

import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'
import { listRunningWslHomeDirsAsync } from '../wsl'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  vi.mocked(listRunningWslHomeDirsAsync).mockClear()
  scanned.dirs = []
  scanned.hostRootHasRollout = false
  setPlatform('win32')
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe('resolveSessionFilePath on a Windows host with WSL', () => {
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
    expect(vi.mocked(listRunningWslHomeDirsAsync)).not.toHaveBeenCalled()
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
