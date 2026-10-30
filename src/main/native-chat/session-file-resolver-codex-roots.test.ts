import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'
import type * as WslRunningPathFilterModule from '../wsl-running-path-filter'

const MANAGED_HOME = '/tmp/orca-user-data/codex-runtime-home/home'

// Polling may read paths only; the launch-time getter mkdirSyncs and would block every tick.
vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: vi.fn(() => MANAGED_HOME),
  resolveOrcaManagedCodexHomePath: vi.fn(() => MANAGED_HOME)
}))

// Disable WSL fallback so the host-roots test behaves identically on every platform.
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  listRunningWslHomeDirsAsync: vi.fn(async () => [])
}))
vi.mock('../wsl-running-path-filter', async (importOriginal) => ({
  ...(await importOriginal<typeof WslRunningPathFilterModule>()),
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
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
import {
  configureHostReadableTranscriptPathSources,
  resetHostReadableTranscriptPathCacheForTests
} from './host-readable-transcript-path'
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

  it('scans per-account homes after the default roots, leaving WSL shares to their tier', async () => {
    const accountHome = '/home/u/.local/share/orca/codex-accounts/a1/home'
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => [accountHome, '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex']
    })

    await resolveSessionFilePath('codex', 'sess-1')

    const accountDir = join(accountHome, 'sessions')
    expect(scanned.dirs).toContain(accountDir)
    expect(scanned.dirs.indexOf(accountDir)).toBeGreaterThan(
      scanned.dirs.indexOf(join(MANAGED_HOME, 'sessions'))
    )
    expect(scanned.dirs.some((dir) => dir.startsWith('\\\\'))).toBe(false)
  })

  it('leaves per-account homes out when the caller names the roots', async () => {
    const getAdditionalCodexHomePaths = vi.fn(() => ['/home/u/acct/home'])
    configureHostReadableTranscriptPathSources({ getAdditionalCodexHomePaths })

    await resolveSessionFilePath('codex', 'sess-1', { codexSessionsDirs: ['/pinned/sessions'] })

    expect(scanned.dirs).toEqual(['/pinned/sessions'])
    expect(getAdditionalCodexHomePaths).not.toHaveBeenCalled()
  })

  it('still answers when the account homes cannot be listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => {
        throw new Error('EACCES')
      }
    })

    await expect(resolveSessionFilePath('codex', 'sess-1')).resolves.toBe(null)
    expect(scanned.dirs).toContain(join(MANAGED_HOME, 'sessions'))
    warn.mockRestore()
  })
})
