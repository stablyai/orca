import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The writer is a spy and the home is a temp folder, so a broken gate cannot reach ~/.codex.
const { install } = vi.hoisted(() => ({ install: vi.fn(async () => {}) }))
vi.mock('../../../app-profiles/app-profile', () => ({ isAppProfileRuntime: () => true }))
vi.mock('./codex-real-home-hook-install', () => ({ reconcileRealHomeCodexHookEntries: install }))
vi.mock('../../trust/hooks/codex-hook-hash-lookup', () => {
  const answer = { kind: 'hashes', hashes: [] }
  return {
    CODEX_HOOK_LAUNCH_WAIT_MS: 1000,
    readKnownCodexHookAnswer: () => answer,
    resolveAppCodexPath: async () => '/bin/codex',
    resolveCodexHookAnswer: async () => answer,
    startCodexHookHashLookup: () => {}
  }
})

import { _internals, reconcileCodexHooks, startCodexHooks } from './codex-hook-reconcile'

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-gate-home-'))
  for (const key of ['HOME', 'CODEX_HOME', 'ORCA_HOME_DIR']) {
    vi.stubEnv(key, home)
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
  _internals.resetForTesting()
  rmSync(home, { recursive: true, force: true })
})

describe('Codex hooks in an app profile', () => {
  it('reconciles nothing at start, on a request or for a launch', async () => {
    startCodexHooks({
      pathReady: Promise.resolve(),
      isEnabled: () => true,
      resolveLaunchHome: () => null
    })
    await _internals.settledForTesting()
    await reconcileCodexHooks({ realHomeLaunch: true, convertOlderForms: true })
    await _internals.settledForTesting()
    expect(install).not.toHaveBeenCalled()
  })
})
