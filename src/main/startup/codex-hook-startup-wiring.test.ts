import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fixture = vi.hoisted(() => {
  const settings: Partial<GlobalSettings> = { agentStatusHooksEnabled: true }
  return {
    app: { isPackaged: true, on: vi.fn() },
    settings,
    pathReady: Promise.resolve(),
    startCodexHooks: vi.fn()
  }
})

vi.mock('electron', () => ({ app: fixture.app, nativeTheme: {} }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../codex/codex-hook-reconcile', () => ({ startCodexHooks: fixture.startCodexHooks }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({
  hydrateAgentCliShellPath: () => fixture.pathReady
}))
// Why the real predicate: the start must read the same opt-out the rest of Orca does.
vi.mock(
  '../agent-hooks/managed-agent-hook-controls',
  async () => await import('../../shared/agent-status-hooks-setting')
)
vi.mock('./main-process-state', () => ({
  mainProcessState: { store: { getSettings: () => fixture.settings } }
}))
vi.mock('./main-process-runtime-service', () => ({
  initializeMainProcessRuntime: () => ({
    setAgentBrowserBridge: vi.fn(),
    setEmulatorBridge: vi.fn()
  }),
  configureRuntimeServices: vi.fn()
}))
vi.mock('../star-nag/service')
vi.mock('../browser/agent-browser-bridge')
vi.mock('../emulator/emulator-bridge')
vi.mock('../runtime/rpc/dispatcher')
vi.mock('../browser/browser-manager', () => ({ browserManager: {} }))
vi.mock('../browser/browser-client-page-automation-runtime')
vi.mock('../crash-reporting/process-gone-diagnostics')
vi.mock('./main-window-lifecycle-flags')
vi.mock('./gpu-lifecycle')
vi.mock('./configure-process', () => ({ shouldInstallManagedHooks: () => false }))
vi.mock('../agent-hooks/install-telemetry')
vi.mock('./main-process-observers')
vi.mock('./main-process-account-services')
vi.mock('./main-process-automations')
vi.mock('./main-process-plugins')
vi.mock('../worktree-trash')
vi.mock('./worktree-removal-records-load')
vi.mock('./first-window-deferral')
vi.mock('./startup-diagnostics')
vi.mock('../opencode/opencode-status-plugin-startup-refresh')

import { initializeReadyRuntimeServices } from './main-process-ready-runtime'

// Why this file: without the start, no managed launch may ask Codex for its hook hash
// and ~/.codex is never reconciled; without the PATH wait, a packaged app looks
// for codex on launchd's PATH and finds none.

beforeEach(() => {
  fixture.startCodexHooks.mockClear()
  fixture.settings.disabledTuiAgents = []
})

describe('Codex hook startup', () => {
  it('starts once in app readiness, after the shell PATH is hydrated', async () => {
    let hydrate: () => void = () => {}
    fixture.pathReady = new Promise<void>((resolve) => {
      hydrate = resolve
    })

    await initializeReadyRuntimeServices()

    expect(fixture.startCodexHooks).toHaveBeenCalledTimes(1)
    let ready = false
    const { pathReady } = fixture.startCodexHooks.mock.calls[0]![0]
    void pathReady.then(() => {
      ready = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ready).toBe(false)
    hydrate()
    await pathReady
    expect(ready).toBe(true)
  })

  it("reads Codex's per-agent hook setting each time it is asked", async () => {
    await initializeReadyRuntimeServices()
    const { isEnabled } = fixture.startCodexHooks.mock.calls[0]![0]

    expect(isEnabled()).toBe(true)
    fixture.settings.disabledTuiAgents = ['codex']
    expect(isEnabled()).toBe(false)
  })
})
