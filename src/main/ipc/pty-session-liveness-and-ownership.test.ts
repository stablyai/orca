import { describe, expect, it, vi } from 'vitest'
import { onMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { AGENT_SESSION_CLAIM_DIGEST_VERSION } from '../../shared/agent-session-host-authority'
import {
  registerPtyHandlers,
  registerSshPtyProvider,
  setPtyOwnership,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'

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

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, mainWindowIpcEvent } = setupPtyIpcSuite()

  it('never answers liveness for a paired-runtime handle from the local registry', async () => {
    const hasPty = vi.fn(() => false)
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      hasPty,
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)

    // The local provider would happily report `false` here — it just doesn't
    // hold the id. Callers read that as "the shell died" (STA-2830).
    await expect(
      handlers.get('pty:hasPty')!(null, { id: 'remote:env-1@@terminal-1' })
    ).resolves.toBe(null)
    expect(hasPty).not.toHaveBeenCalled()
  })
  it.each(['remote:env-1@@terminal-1', 'ssh:missing-host@@pty-1'])(
    'never routes process inspection for %s to the local provider',
    async (id) => {
      const inspectProcess = vi.fn()
      registerPtyHandlers(mainWindow as never)
      setLocalPtyProvider({ inspectProcess } as never)

      await expect(handlers.get('pty:inspectProcess')!(null, { id })).resolves.toEqual({
        foregroundProcess: null,
        hasChildProcesses: false,
        unavailable: true
      })
      expect(inspectProcess).not.toHaveBeenCalled()
    }
  )
  it('lists duplicate SSH relay session ids as distinct app sessions', async () => {
    registerPtyHandlers(mainWindow as never)
    const shutdownA = vi.fn(async () => undefined)
    const shutdownB = vi.fn(async () => undefined)
    registerSshPtyProvider('ssh-a', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: shutdownA,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [
        { id: 'ssh:ssh-a@@pty-1', cwd: '/repo-a', title: 'ssh-a' }
      ]),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerSshPtyProvider('ssh-b', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: shutdownB,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [
        { id: 'ssh:ssh-b@@pty-1', cwd: '/repo-b', title: 'ssh-b' }
      ]),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      cwd: string
      title: string
    }[]

    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ssh:ssh-a@@pty-1', cwd: '/repo-a' }),
        expect.objectContaining({ id: 'ssh:ssh-b@@pty-1', cwd: '/repo-b' })
      ])
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-a@@pty-1' })
    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-b@@pty-1' })

    expect(shutdownA).toHaveBeenCalledWith('ssh:ssh-a@@pty-1', {
      immediate: true,
      keepHistory: false
    })
    expect(shutdownB).toHaveBeenCalledWith('ssh:ssh-b@@pty-1', {
      immediate: true,
      keepHistory: false
    })
  })
  it('reports agent ownership through pty:listSessions so the renderer cannot guess it', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: the renderer's binding map is empty during restore, so agent ownership is the only
    // positive liveness evidence it has. Dropping it here force-killed live sessions (#8459).
    const owner = {
      claim: {
        digestVersion: AGENT_SESSION_CLAIM_DIGEST_VERSION,
        keyId: 'key-1',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        agent: 'codex'
      },
      generation: 'gen-1',
      phase: 'live',
      ptyId: 'agent-pty',
      surface: {
        worktreeId: 'repo::/workspace',
        tabId: 'tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_claimed'
      }
    }
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [
        { id: 'agent-pty', cwd: '/workspace', title: 'codex', agentSessionOwners: [owner] },
        { id: 'plain-pty', cwd: '/tmp', title: 'zsh' }
      ]),
      // Why: this provider serializes claims, so its silence about an owner is authoritative.
      providesAgentSessionOwnerListings: () => true,
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      agentOwnership: string
    }[]

    expect(sessions.find((s) => s.id === 'agent-pty')?.agentOwnership).toBe('present')
    expect(sessions.find((s) => s.id === 'plain-pty')?.agentOwnership).toBe('absent')
  })
  it('reports unknown ownership when the provider cannot serialize claims', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: a legacy daemon generation or older SSH relay lists no owners for a session that may
    // have one. Reporting that silence as 'absent' is what let live agent sessions be killed (#8459).
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => [{ id: 'legacy-pty', cwd: '/workspace', title: 'zsh' }]),
      providesAgentSessionOwnerListings: () => false,
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    const sessions = (await handlers.get('pty:listSessions')!(null, undefined)) as {
      id: string
      agentOwnership: string
    }[]

    expect(sessions.find((s) => s.id === 'legacy-pty')?.agentOwnership).toBe('unknown')
  })
  it('kills app-scoped SSH PTY ids through the parsed provider when ownership is not rebuilt', async () => {
    const localShutdown = vi.fn()
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: localShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const sshShutdown = vi.fn(async () => undefined)
    const store = { markSshRemotePtyLease: vi.fn(), clearSshRemotePtyKillIntent: vi.fn() }
    registerSshPtyProvider('ssh-1', {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: sshShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })

    expect(sshShutdown).toHaveBeenCalledWith('ssh:ssh-1@@relay-pty', {
      immediate: true,
      keepHistory: false
    })
    expect(localShutdown).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
  })
  it('tombstones app-scoped SSH PTY ids instead of falling back local when ownership and provider are absent', async () => {
    const localShutdown = vi.fn()
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: localShutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    const store = { markSshRemotePtyLease: vi.fn(), clearSshRemotePtyKillIntent: vi.fn() }
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await handlers.get('pty:kill')!(null, { id: 'ssh:ssh-1@@relay-pty' })

    expect(localShutdown).not.toHaveBeenCalled()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'relay-pty', 'terminated')
  })
  it('ignores fire-and-forget IPC for detached SSH PTYs without a provider', async () => {
    const store = {
      upsertSshRemotePtyLease: vi.fn(),
      persistPtyBinding: vi.fn(),
      markSshRemotePtyLease: vi.fn(),
      clearSshRemotePtyKillIntent: vi.fn()
    }
    const provider = {
      spawn: vi.fn(async () => ({ id: 'remote-pty' })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(async () => undefined),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
    registerSshPtyProvider('ssh-1', provider as never)
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      store as never
    )
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      env: {}
    })
    unregisterSshPtyProvider('ssh-1')
    const listenerFor = (channel: string): ((event: unknown, args: unknown) => void) => {
      const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
      if (!call) {
        throw new Error(`missing ${channel} listener`)
      }
      return call[1] as (event: unknown, args: unknown) => void
    }

    expect(() =>
      listenerFor('pty:write')(mainWindowIpcEvent, { id: 'remote-pty', data: 'x' })
    ).not.toThrow()
    expect(() =>
      listenerFor('pty:resize')(null, { id: 'remote-pty', cols: 100, rows: 30 })
    ).not.toThrow()
    expect(() => listenerFor('pty:ackColdRestore')(null, { id: 'remote-pty' })).not.toThrow()
    expect(() =>
      listenerFor('pty:signal')(null, { id: 'remote-pty', signal: 'SIGINT' })
    ).not.toThrow()

    await expect(handlers.get('pty:kill')!(null, { id: 'remote-pty' })).resolves.toBeUndefined()
    expect(store.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'remote-pty', 'terminated')
  })
  it('returns idle process inspection results for detached SSH PTYs without a provider', async () => {
    const provider = {
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
    registerSshPtyProvider('ssh-1', provider as never)
    registerPtyHandlers(mainWindow as never)
    setPtyOwnership('remote-pty', 'ssh-1')
    unregisterSshPtyProvider('ssh-1')

    await expect(handlers.get('pty:hasChildProcesses')!(null, { id: 'remote-pty' })).resolves.toBe(
      false
    )
    await expect(
      handlers.get('pty:getForegroundProcess')!(null, { id: 'remote-pty' })
    ).resolves.toBeNull()
    await expect(
      handlers.get('pty:confirmForegroundProcess')!(null, { id: 'remote-pty' })
    ).resolves.toBeNull()
    expect(provider.hasChildProcesses).not.toHaveBeenCalled()
    expect(provider.getForegroundProcess).not.toHaveBeenCalled()
    expect(provider.confirmForegroundProcess).not.toHaveBeenCalled()
  })
  it('preserves unavailable process inspection results from the provider', async () => {
    const inspectProcess = vi.fn(async () => ({
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
    }))
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ inspectProcess } as never)

    await expect(
      handlers.get('pty:inspectProcess')!(null, { id: 'legacy-daemon-pty' })
    ).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true
    })
  })
  it('settles a stale renderer process inspection as unavailable', async () => {
    registerPtyHandlers(mainWindow as never)
    setLocalPtyProvider({ hasPty: vi.fn(() => false) } as never)

    await expect(handlers.get('pty:inspectProcess')!(null, { id: 'gone-pty' })).resolves.toEqual({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    })
  })
})
