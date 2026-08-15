import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createManagedAuth,
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState,
  writePaneRegistry
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService pane model discovery', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('resolves model discovery to the managed account pinned to the PTY', async () => {
    const homeA = createManagedAuth(testState.userDataDir, 'account-a', '{"a":true}\n')
    const homeB = createManagedAuth(testState.userDataDir, 'account-b', '{"b":true}\n')
    writePaneRegistry({
      'pty-account-a': {
        selectionKey: 'host',
        accountId: 'account-a',
        homeRoute: 'account-home'
      }
    })
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-a', 'a@example.com', 'acct-a', homeA),
          createCodexAccountRecord('account-b', 'b@example.com', 'acct-b', homeB)
        ],
        activeCodexManagedAccountId: 'account-b',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-b', wsl: {} }
      })
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(
      service.resolveCodexHomeForPaneModelDiscovery('pty-account-a', { runtime: 'host' })
    ).toBe(homeA)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-b')
  })

  it('pins PTY system-default discovery to the real home path', async () => {
    writePaneRegistry({
      'pty-system': { selectionKey: 'host', accountId: null, homeRoute: 'real-home' }
    })
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: true }))

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.resolveCodexHomeForPaneModelDiscovery('pty-system', { runtime: 'host' })).toBe(
      getSystemCodexHomePath()
    )
  })

  it('resolves a managed WSL PTY within its recorded distro lane', async () => {
    const managedHomePath = '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex-account-a'
    const account = {
      ...createCodexAccountRecord('account-a', 'a@example.com', 'acct-a', managedHomePath),
      managedHomeRuntime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: '/home/tester/.codex-account-a'
    }
    writePaneRegistry({
      'pty-wsl-a': {
        selectionKey: 'wsl:Ubuntu',
        accountId: 'account-a',
        homeRoute: 'wsl-home'
      }
    })
    const store = createStore(
      createSettings({
        codexManagedAccounts: [account],
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-a' } }
      })
    )

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(
      service.resolveCodexHomeForPaneModelDiscovery('pty-wsl-a', {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ).toBe(managedHomePath)
  })

  it('fails closed when a PTY references a managed account that was removed', async () => {
    writePaneRegistry({
      'pty-removed': {
        selectionKey: 'host',
        accountId: 'removed-account',
        homeRoute: 'account-home'
      }
    })
    const store = createStore(createSettings())

    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(() =>
      service.resolveCodexHomeForPaneModelDiscovery('pty-removed', { runtime: 'host' })
    ).toThrow('no longer available')
  })
})
