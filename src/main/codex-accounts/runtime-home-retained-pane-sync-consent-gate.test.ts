import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

type SyncLegacySharedAccessible = {
  syncLegacySharedSystemDefaultAuthForRetainedPanes(): void
}

// G2: syncLegacySharedSystemDefaultAuthForRetainedPanes (reached from
// reconcileLegacySharedHomeForRetainedPanes and the rate-limit-fetch usage-home path) read
// ~/.codex/auth.json and called writeRuntimeAuth with no hasCredentialMirrorConsent() check, so a
// retained legacy pane still copied the system-default credential into the runtime home mirror
// after the user withheld (or revoked) mirror consent.
describe('CodexRuntimeHomeService retained-pane sync consent gate (G2)', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('writes no runtime auth.json when a retained pane sync detects a system-default change without consent', async () => {
    const systemAuth = '{"account":"system-current"}\n'
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ codexCredentialMirrorConsent: false }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    // Why: seed a stale logout marker directly so the sync method's
    // "system-default-changed" branch fires without depending on unrelated sync paths.
    writeFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'system-default-runtime-logout.json'),
      `${JSON.stringify({ systemDefaultAuthJson: '{"account":"system-old"}\n', loggedOutAt: 1 })}\n`,
      'utf-8'
    )
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    expect(existsSync(runtimeAuthPath)).toBe(false)

    ;(
      service as unknown as SyncLegacySharedAccessible
    ).syncLegacySharedSystemDefaultAuthForRetainedPanes()

    expect(existsSync(runtimeAuthPath)).toBe(false)
  })
})
