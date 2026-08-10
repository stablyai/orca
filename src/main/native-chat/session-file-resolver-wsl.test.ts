import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsModule from 'node:fs'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const WSL_MANAGED_SESSIONS_DIR = `${UBUNTU_HOME}\\.local\\share\\orca\\codex-runtime-home\\home\\sessions`
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-wsl-sess.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-wsl-sess.jsonl'

vi.mock('../wsl', () => ({
  listWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  getWslHomeAsync: vi.fn(async () => UBUNTU_HOME)
}))

// Only WSL UNC paths are readable; the guest Linux path is not (as on a real
// Windows host, where it would misresolve against the current drive).
const fsState = vi.hoisted(() => ({ existsAll: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  return {
    ...actual,
    existsSync: (path: string) =>
      fsState.existsAll || path.startsWith('\\\\wsl.localhost\\') || actual.existsSync(path)
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
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  vi.mocked(getWslHomeAsync).mockClear()
  vi.mocked(listWslDistrosAsync).mockClear()
  scanned.dirs = []
  scanned.hostRootHasRollout = false
  fsState.existsAll = false
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

  it('searches the WSL managed Codex sessions root when no hook path is known', async () => {
    await resolveSessionFilePath('codex', 'wsl-sess')
    expect(scanned.dirs).toContain(WSL_MANAGED_SESSIONS_DIR)
    expect(scanned.dirs).toContain(`${UBUNTU_HOME}\\.codex\\sessions`)
  })

  it('does not enumerate WSL distros when a host Codex root already has the rollout', async () => {
    // Why: listing WSL homes spawns wsl.exe per distro, which boots distros the
    // user deliberately left stopped. It must stay a last resort.
    fsState.existsAll = true
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
