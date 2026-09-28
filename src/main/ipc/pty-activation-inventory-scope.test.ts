import { registerWslPtyProvider } from './pty/provider/registry'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'
import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerSshPtyProvider, getLocalPtyProvider } from './pty'
import { installPtyInspectIpcHandlers } from './pty/ipc/inspect'
import { ptyOwnership } from './pty/provider/ownership-state'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
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

  it('includes both guest owners in local scope and refuses partial guest inventory', async () => {
    const { list, remoteLists } = install()
    const firstOwner = { distro: 'Ubuntu', relayBuildId: 'build-a' }
    const secondOwner = { distro: 'Debian', relayBuildId: 'build-b' }
    const firstId = toAppWslPtyId(firstOwner, 'pty2:guest:1')
    const secondId = toAppWslPtyId(secondOwner, 'pty2:guest:1')
    const first = vi.fn(async () => [
      { id: firstId, cwd: '/folder one', title: 'guest', worktreeId: 'folder-project' }
    ])
    const second = vi.fn(async () => [{ id: secondId, cwd: '/folder two', title: 'guest' }])
    const releaseFirst = registerWslPtyProvider(firstOwner, {
      ...getLocalPtyProvider(),
      listProcesses: first
    })
    const releaseSecond = registerWslPtyProvider(secondOwner, {
      ...getLocalPtyProvider(),
      listProcesses: second
    })
    try {
      const rows = await list({ connectionId: null })
      if (!Array.isArray(rows)) {
        throw new Error('Expected session inventory')
      }
      expect(rows.map((row: { id: string }) => row.id)).toEqual(['local', firstId, secondId])
      expect(rows[1]).toMatchObject({ cwd: '/folder one', worktreeId: 'folder-project' })
      expect(remoteLists.every((remote) => remote.mock.calls.length === 0)).toBe(true)
      second.mockRejectedValue(new Error('disconnected'))
      await expect(list({ connectionId: null })).rejects.toThrow('unverifiable')
      releaseSecond()
      await expect(list({ connectionId: null })).rejects.toThrow('unverifiable')
      expect(await list({ connectionId: 'host-17' })).toHaveLength(1)
    } finally {
      releaseFirst()
      releaseSecond()
      ptyOwnership.delete(firstId)
      ptyOwnership.delete(secondId)
    }
  })

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
})
