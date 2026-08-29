import { describe, expect, it, vi } from 'vitest'
import { readFileSyncMock, spawnMock, recordCodexPaneAccountMock } from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_CODEX_HOME } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from '../../shared/terminal-input'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { registerPtyHandlers, deletePtyOwnership, setLocalPtyProvider } from './pty'

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
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    installDaemonTestProvider,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  it('acknowledges pty writes only for owned PTYs', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: result.id,
        data: '\x03'
      })
    ).toBe(true)
    expect(mockProc.proc.write).toHaveBeenCalledWith('\x03')
    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: 'missing-pty-for-write-ack',
        data: '\x03'
      })
    ).toBe(false)
    expect(mockProc.proc.write).toHaveBeenCalledTimes(1)
  })
  it('asks the renderer to remount when the provider rejects a stale daemon write', async () => {
    const write = vi.fn(() => {
      throw new PtyWriteUnavailableError('daemon generation lost')
    })
    installDaemonTestProvider({ write })
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    mainWindow.webContents.send.mockClear()

    getPtyWriteListener()(mainWindowIpcEvent, { id: result.id, data: 'x' })

    expect(write).toHaveBeenCalledWith(result.id, 'x')
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:writeUnavailable', {
      id: result.id
    })
  })
  it('rejects malformed and cross-window pty write IPC before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const write = getPtyWriteListener() as (event: unknown, args: unknown) => void
    const writeAccepted = handlers.get('pty:writeAccepted')! as (
      event: unknown,
      args: unknown
    ) => unknown

    write(mainWindowIpcEvent, null)
    write(mainWindowIpcEvent, { id: '', data: 'x' })
    write(mainWindowIpcEvent, { id: result.id, data: 1 })
    write(foreignWindowIpcEvent, { id: result.id, data: 'x' })

    expect(writeAccepted(mainWindowIpcEvent, null)).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: '', data: 'x' })).toBe(false)
    expect(writeAccepted(mainWindowIpcEvent, { id: result.id, data: 1 })).toBe(false)
    expect(writeAccepted(foreignWindowIpcEvent, { id: result.id, data: 'x' })).toBe(false)
    expect(mockProc.proc.write).not.toHaveBeenCalled()
  })
  it('silently drops writes to a live PTY after ownership loss until pty:listSessions rebuilds it (frozen-terminal repro)', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const write = getPtyWriteListener()

    write(mainWindowIpcEvent, { id: result.id, data: 'alive' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('alive')

    // Field failure (Discord #performance / #2836): a pane can render with a ptyId whose ownership is gone while the PTY lives, so keystrokes vanish silently.
    deletePtyOwnership(result.id)
    write(mainWindowIpcEvent, { id: result.id, data: 'dropped' })
    expect(mockProc.proc.write).not.toHaveBeenCalledWith('dropped')

    // pty:listSessions rebuilds ownership from provider sessions — the revival lever the frozen-pane e2e probes depend on.
    await handlers.get('pty:listSessions')!(null, undefined)
    write(mainWindowIpcEvent, { id: result.id, data: 'revived' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('revived')
  })
  it('chunks large acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const text = ['x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES), 'tail'].join('')

    await expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, { id: result.id, data: text })
    ).resolves.toBe(true)

    expect(mockProc.proc.write).toHaveBeenNthCalledWith(
      1,
      'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES)
    )
    expect(mockProc.proc.write).toHaveBeenNthCalledWith(2, 'tail')
  })
  it('yields while validating accepted large acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    vi.useFakeTimers()
    const writeResult = handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
      id: result.id,
      data: text
    })

    expect(writeResult).toBeInstanceOf(Promise)
    expect(mockProc.proc.write).not.toHaveBeenCalled()

    await vi.runAllTimersAsync()
    await expect(writeResult).resolves.toBe(true)
    expect(mockProc.proc.write.mock.calls.map(([chunk]) => chunk).join('')).toBe(text)
  })
  it('rejects oversized acknowledged pty writes before provider writes', async () => {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    registerPtyHandlers(mainWindow as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24
    })) as { id: string }

    expect(
      handlers.get('pty:writeAccepted')!(mainWindowIpcEvent, {
        id: result.id,
        data: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1)
      })
    ).toBe(false)
    expect(mockProc.proc.write).not.toHaveBeenCalled()
  })
  it('synchronizes runtime output sequencing from a provider reattach snapshot', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-restored',
        isReattach: true,
        providerSequence: { value: 900, generation: 'continued' as const }
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getPtyOutputSequence: vi.fn().mockReturnValue(7),
      synchronizePtyOutputSequenceFromProvider: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.synchronizePtyOutputSequenceFromProvider).toHaveBeenCalledWith(
      'pty-restored',
      { value: 900, generation: 'continued' },
      7
    )
  })
  it('pairs the daemon kitty flags with the reconciled boundary when no bytes crossed mid-spawn', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-restored',
        isReattach: true,
        providerSequence: { value: 900, generation: 'continued' as const },
        snapshotKittyKeyboardFlags: 8
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getPtyOutputSequence: vi.fn().mockReturnValue(7),
      synchronizePtyOutputSequenceFromProvider: vi.fn().mockReturnValue(920),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    const reply = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      snapshotSeq?: number
      snapshotKittyKeyboardFlags?: number
    }

    expect(reply.snapshotKittyKeyboardFlags).toBe(8)
    expect(reply.snapshotSeq).toBe(920)
  })
  it('drops the daemon kitty flags claim when bytes crossed the data socket mid-spawn', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-restored',
        isReattach: true,
        providerSequence: { value: 900, generation: 'continued' as const },
        snapshotKittyKeyboardFlags: 8
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      // 7 at spawn start, 20 at reconcile: bytes arrived during the spawn RPC.
      getPtyOutputSequence: vi.fn().mockReturnValueOnce(7).mockReturnValue(20),
      synchronizePtyOutputSequenceFromProvider: vi.fn().mockReturnValue(920),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    const reply = (await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })) as {
      snapshotSeq?: number
      snapshotKittyKeyboardFlags?: number
    }

    // The reconciled boundary covers bytes the daemon's flags were proven
    // BEFORE — publishing both would erase a negotiation the pane scanned live.
    expect(reply.snapshotKittyKeyboardFlags).toBeUndefined()
    expect(reply.snapshotSeq).toBeUndefined()
  })
  it('records the launch Codex account for a fresh spawn but not for a reattach', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-fresh' })
      .mockResolvedValueOnce({ id: 'pty-reattached', isReattach: true })
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: 'account-a' })
    registerPtyHandlers(mainWindow as never, undefined, undefined, getSettings as never)

    const nativeCodexEnv = { CODEX_HOME: '', ORCA_CODEX_HOME: '' }
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, env: nativeCodexEnv })
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      env: nativeCodexEnv,
      sessionId: 'pty-reattached'
    })

    // Why: a reattached shell keeps the CODEX_HOME baked in at its original
    // spawn, so re-recording it under the current selection would erase the only
    // evidence that the pane is stale.
    expect(recordCodexPaneAccountMock.mock.calls).toEqual([
      ['pty-fresh', { selectionKey: 'host', accountId: 'account-a', homeRoute: 'real-home' }]
    ])
  })
  it('refreshes the WSL hook relay for the distro a reattached pane already owns', async () => {
    // Why here and not only in the helper's unit test: nothing else catches pty.ts dropping the
    // reattach call — the manager owns the hooks/platform gating this spy stands in for.
    const ensureForDistro = vi
      .spyOn(wslHookRelayManager, 'ensureForDistro')
      .mockImplementation(() => {})
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({ id: 'pty-wsl', isReattach: true, wslDistro: 'Ubuntu-24.04' })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(mainWindow as never)

    try {
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: 'pty-wsl' })
      expect(ensureForDistro).toHaveBeenCalledWith('Ubuntu-24.04')
    } finally {
      ensureForDistro.mockRestore()
    }
  })
  posixOnlyIt(
    'does not guess route provenance for a pane-local shell startup CODEX_HOME',
    async () => {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'pty-custom-home' })),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        shutdown: vi.fn(),
        onData: vi.fn(() => vi.fn()),
        onExit: vi.fn(() => vi.fn()),
        listProcesses: vi.fn(async () => []),
        getForegroundProcess: vi.fn(async () => null)
      } as never)
      readFileSyncMock.mockImplementation((path: string) =>
        path === '/pane-home/.zshrc' ? 'export CODEX_HOME="$HOME/custom-codex-home"\n' : ''
      )
      const getSettings = vi.fn().mockReturnValue({ activeCodexManagedAccountId: null })
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        () => TEST_CODEX_HOME,
        getSettings as never
      )

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        env: {
          CODEX_HOME: '',
          ORCA_CODEX_HOME: '',
          HOME: '/pane-home',
          SHELL: '/bin/zsh'
        }
      })

      expect(recordCodexPaneAccountMock).toHaveBeenCalledWith('pty-custom-home', {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'custom-home'
      })
    }
  )
})
