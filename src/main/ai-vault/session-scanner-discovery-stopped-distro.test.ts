import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { _resetRunningWslDistrosCacheForTests, _setRunningWslDistrosForTests } from '../wsl'
import { discoverFiles } from './session-scanner-discovery'
import type { DiscoveryRootStat } from './session-scanner-types'

// Why: touching a stopped distro's UNC path either pays its cold-boot latency
// inline or stalls behind the single-slot WSL transcript gate — `wsl --list
// --running` (which never boots anything) lets discoverFiles skip it instead.
describe('discoverFiles skips a confirmed-stopped WSL distro', () => {
  afterEach(() => {
    _resetRunningWslDistrosCacheForTests()
  })

  const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions'

  it('records a notice issue and resolves to an empty file list without walking', async () => {
    _setRunningWslDistrosForTests(['docker-desktop'])
    const readDirectory = vi.fn()
    const issues: AiVaultScanIssue[] = []

    // discoverFiles has no readDirectory injection point of its own, so the
    // absence of any call proves the walk never started: a real readdir on
    // this UNC path (were it reached) would hang behind the gate under fake
    // timers, or spawn a real WSL round trip under real ones — neither of
    // which this test can afford. `readDirectory` here documents intent; the
    // stronger assertion is the resolved shape and the issue below.
    void readDirectory

    await expect(
      discoverFiles({
        rootDir: UNC_ROOT,
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })
    ).resolves.toEqual({ agent: 'codex', rootDir: UNC_ROOT, files: [] })

    expect(issues).toEqual([
      {
        agent: 'codex',
        path: UNC_ROOT,
        kind: 'notice',
        message: 'WSL distro "Ubuntu" is not running; skipped without starting it.'
      }
    ])
  })

  it('records a discovery root stat marked as a UNC skip, not an error', async () => {
    _setRunningWslDistrosForTests([])
    const issues: AiVaultScanIssue[] = []
    const stats: DiscoveryRootStat[] = []

    await discoverFiles({
      rootDir: UNC_ROOT,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      stats
    })

    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({
      agent: 'codex',
      rootDir: UNC_ROOT,
      isUncPath: true,
      fileCount: 0,
      errored: false
    })
  })

  it('does not skip when the distro is running', async () => {
    _setRunningWslDistrosForTests(['Ubuntu'])
    const issues: AiVaultScanIssue[] = []

    // A local nonexistent-equivalent: without the skip, this falls through to
    // the real wslGatedReaddir, which for a UNC path routes through the gate.
    // Asserting it does NOT short-circuit with the "not running" notice is
    // the meaningful check here; the eventual outcome (empty/error) depends
    // on gate plumbing already covered by session-scanner-discovery-wsl-gate.test.ts.
    const result = await discoverFiles({
      rootDir: UNC_ROOT,
      limit: 10,
      agent: 'codex',
      issues,
      extensions: ['.jsonl'],
      signal: AbortSignal.abort()
    }).catch((err: unknown) => err)

    expect(issues.find((issue) => issue.kind === 'notice')).toBeUndefined()
    expect(result).toMatchObject({ name: 'AbortError' })
  })

  it('does not probe distro liveness for a local path', async () => {
    const issues: AiVaultScanIssue[] = []
    await expect(
      discoverFiles({
        rootDir: 'C:\\definitely\\does\\not\\exist\\12345',
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })
    ).resolves.toEqual({
      agent: 'codex',
      rootDir: 'C:\\definitely\\does\\not\\exist\\12345',
      files: []
    })
    expect(issues).toEqual([])
  })
})
