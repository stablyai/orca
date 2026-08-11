// Why: qodercli is the only agent whose managed hooks span two config roots (`~/.qoder` for the
// global build, `~/.qoder-cn` for the China build) behind a single agent id. The install/remove
// mechanics are ClaudeHookService's and are covered by installer-utils.test.ts; this file covers
// the only qodercli-specific logic — collapsing two per-root statuses into one.
import { describe, expect, it, vi } from 'vitest'

// Why: hook-service.ts reaches Electron's userData path through installer-utils at import time.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { combineQoderCliHookStatuses } from './hook-service'

function status(overrides: Partial<AgentHookInstallStatus> = {}): AgentHookInstallStatus {
  return {
    agent: 'qodercli',
    state: 'installed',
    configPath: '/home/dev/.qoder/settings.json',
    managedHooksPresent: true,
    detail: null,
    ...overrides
  }
}

describe('combineQoderCliHookStatuses', () => {
  it('keeps the shared state when both config roots agree', () => {
    const combined = combineQoderCliHookStatuses(
      status(),
      status({ configPath: '/home/dev/.qoder-cn/settings.json' })
    )
    expect(combined.state).toBe('installed')
    expect(combined.managedHooksPresent).toBe(true)
    // Why: the global root is the canonical one Orca reports against.
    expect(combined.configPath).toBe('/home/dev/.qoder/settings.json')
  })

  it('reports partial when the two roots disagree', () => {
    const combined = combineQoderCliHookStatuses(
      status({ state: 'installed' }),
      status({ state: 'error', detail: 'Could not parse settings.json' })
    )
    expect(combined.state).toBe('partial')
    // Why: one root really does carry managed hooks, so this must not read as a clean uninstall.
    expect(combined.managedHooksPresent).toBe(true)
  })

  it('reports partial when only the CN root installed', () => {
    const combined = combineQoderCliHookStatuses(
      status({ state: 'not_installed', managedHooksPresent: false }),
      status({ state: 'installed' })
    )
    expect(combined.state).toBe('partial')
    expect(combined.managedHooksPresent).toBe(true)
  })

  it('collapses managedHooksPresent to false only when neither root has them', () => {
    const combined = combineQoderCliHookStatuses(
      status({ state: 'not_installed', managedHooksPresent: false }),
      status({ state: 'not_installed', managedHooksPresent: false })
    )
    expect(combined.state).toBe('not_installed')
    expect(combined.managedHooksPresent).toBe(false)
  })

  it('attributes each detail to the config root it came from', () => {
    const combined = combineQoderCliHookStatuses(
      status({ state: 'error', detail: 'global boom' }),
      status({ state: 'error', detail: 'cn boom' })
    )
    expect(combined.detail).toBe('.qoder: global boom; .qoder-cn: cn boom')
  })

  it('returns a null detail when neither root reported one', () => {
    expect(combineQoderCliHookStatuses(status(), status()).detail).toBeNull()
  })
})
