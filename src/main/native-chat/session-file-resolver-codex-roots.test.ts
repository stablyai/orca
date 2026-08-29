import { beforeEach, describe, expect, it, vi } from 'vitest'

const MANAGED_HOME = '/tmp/orca-user-data/codex-runtime-home/home'

// Why: only the path-only variant may run on the resolve poll — the getter
// mkdirSyncs the runtime home, which is launch-time work and blocks the main
// thread on every tick.
vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: vi.fn(() => MANAGED_HOME),
  resolveOrcaManagedCodexHomePath: vi.fn(() => MANAGED_HOME)
}))

// Keeps the WSL fallback tier inert so this stays a host-roots test on any platform.
vi.mock('../wsl', () => ({
  listWslDistrosAsync: vi.fn(async () => []),
  getWslHomeAsync: vi.fn(async () => null)
}))

const scanned = vi.hoisted(() => ({ dirs: [] as string[] }))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: async (dir: string) => {
    scanned.dirs.push(dir)
    return []
  }
}))

import { join } from 'node:path'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { resolveSessionFilePath } from './session-file-resolver'

beforeEach(() => {
  resetHostReadableTranscriptPathCacheForTests()
  vi.mocked(getOrcaManagedCodexHomePath).mockClear()
  scanned.dirs = []
})

describe('codex sessions roots', () => {
  it('scans the managed home without materializing it', async () => {
    await resolveSessionFilePath('codex', 'sess-1')

    expect(scanned.dirs).toContain(join(MANAGED_HOME, 'sessions'))
    expect(vi.mocked(getOrcaManagedCodexHomePath)).not.toHaveBeenCalled()
  })
})
