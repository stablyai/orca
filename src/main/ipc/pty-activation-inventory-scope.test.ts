import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerSshPtyProvider, getLocalPtyProvider } from './pty'
import { installPtyInspectIpcHandlers } from './pty/ipc/inspect'
import { ptyOwnership } from './pty/provider/ownership-state'
import {
  bindDelegatedPtyProviderRoute,
  retireDelegatedPtyProviderRoute
} from './pty/provider/delegated-provider-routes'
import { identity as delegatedIdentity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('scoped activation PTY inventory', () => {
  const { handlers, installDaemonTestProvider } = setupPtyIpcSuite()

  function install() {
    const localList = vi.fn(async () => [{ id: 'local', cwd: '/', title: 'shell' }])
    installDaemonTestProvider({ listProcesses: localList })
    const remoteLists = Array.from({ length: 50 }, (_, index) => {
      const list = vi.fn(async () => [
        {
          id: `ssh:host-${index}@@pty-1`,
          cwd: '/remote',
          title: 'agent',
          worktreeId: 'repo::/remote'
        }
      ])
      registerSshPtyProvider(`host-${index}`, {
        ...getLocalPtyProvider(),
        listProcesses: list,
        providesAgentSessionOwnerListings: () => true
      })
      return list
    })
    const startup = vi.fn(async () => {})
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: startup })
    const list = (scope?: unknown) => handlers.get('pty:listSessions')!(null, scope)
    return { localList, remoteLists, startup, list }
  }

  it('queries only the chosen SSH provider and preserves workspace and ownership evidence', async () => {
    const { list, localList, remoteLists, startup } = install()
    expect(await list({ connectionId: 'host-17' })).toEqual([
      {
        id: 'ssh:host-17@@pty-1',
        cwd: '/remote',
        title: 'agent',
        worktreeId: 'repo::/remote',
        agentOwnership: 'absent'
      }
    ])
    expect(remoteLists[17]).toHaveBeenCalledOnce()
    expect(remoteLists.reduce((count, mock) => count + mock.mock.calls.length, 0)).toBe(1)
    expect(localList).not.toHaveBeenCalled()
    expect(startup).not.toHaveBeenCalled()
    expect(ptyOwnership.get('ssh:host-17@@pty-1')).toBe('host-17')
  })

  it('waits for local startup and never visits remote providers for a local scope', async () => {
    const { list, localList, remoteLists, startup } = install()
    let release!: () => void
    startup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = list({ connectionId: null })
    expect(localList).not.toHaveBeenCalled()
    release()
    await pending
    expect(localList).toHaveBeenCalledOnce()
    expect(remoteLists.every((mock) => mock.mock.calls.length === 0)).toBe(true)
  })

  it('propagates selected-host failure and never substitutes the local inventory', async () => {
    const { list, localList, remoteLists } = install()
    remoteLists[3].mockRejectedValue(new Error('relay unavailable'))
    await expect(list({ connectionId: 'host-3' })).rejects.toThrow('relay unavailable')
    await expect(list({ connectionId: 'missing' })).rejects.toThrow('No PTY provider')
    expect(localList).not.toHaveBeenCalled()
  })

  it.each([null, {}, { connectionId: '' }, { connectionId: 42 }])(
    'rejects malformed scope %j before inventory admission',
    async (scope) => {
      const { list, localList, remoteLists } = install()
      await expect(list(scope)).rejects.toThrow('invalid_pty_session_list_scope')
      expect(localList).not.toHaveBeenCalled()
      expect(remoteLists.every((mock) => mock.mock.calls.length === 0)).toBe(true)
    }
  )

  it('preserves unscoped diagnostic inventory and its remote-error fallback', async () => {
    const { list, localList, remoteLists } = install()
    remoteLists[3].mockRejectedValue(new Error('relay unavailable'))
    expect(await list()).toHaveLength(50)
    expect(localList).toHaveBeenCalledOnce()
    expect(remoteLists.every((mock) => mock.mock.calls.length === 1)).toBe(true)
  })

  it('includes delegated ownership in a local scope without admitting the old native row', async () => {
    const { list, localList, remoteLists } = install()
    const identity = { ...delegatedIdentity, terminalId: 'scoped-delegated' }
    const claim = { generation: 1, claimId: 'scoped-current' }
    localList.mockResolvedValue([{ id: identity.terminalId, cwd: '/old', title: 'old native' }])
    const delegatedList = vi.fn(async () => [
      {
        id: identity.terminalId,
        incarnationId: identity.incarnationId,
        cwd: '/delegated',
        title: 'current owner',
        worktreeId: 'folder-workspace'
      }
    ])
    bindDelegatedPtyProviderRoute(identity, claim, {
      ...getLocalPtyProvider(),
      listProcesses: delegatedList
    })
    try {
      await expect(list({ connectionId: null })).resolves.toEqual([
        {
          id: identity.terminalId,
          cwd: '/delegated',
          title: 'current owner',
          worktreeId: 'folder-workspace',
          agentOwnership: 'unknown'
        }
      ])
      expect(delegatedList).toHaveBeenCalledOnce()
      expect(remoteLists.every((mock) => mock.mock.calls.length === 0)).toBe(true)
    } finally {
      retireDelegatedPtyProviderRoute(identity, claim)
    }
  })

  it('rejects local-scope inventory when its delegated owner changes during the read', async () => {
    const { list } = install()
    const identity = { ...delegatedIdentity, terminalId: 'scoped-replaced-delegated' }
    const claim = { generation: 1, claimId: 'first' }
    const pending = Promise.withResolvers<never[]>()
    const disconnect = bindDelegatedPtyProviderRoute(identity, claim, {
      ...getLocalPtyProvider(),
      listProcesses: vi.fn(() => pending.promise)
    })
    try {
      const inventory = list({ connectionId: null })
      await Promise.resolve()
      disconnect()
      pending.resolve([])
      await expect(inventory).rejects.toThrow('delegated_pty_inventory_superseded')
    } finally {
      retireDelegatedPtyProviderRoute(identity, claim)
    }
  })
})
