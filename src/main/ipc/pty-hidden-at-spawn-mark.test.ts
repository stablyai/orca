import { describe, expect, it, vi } from 'vitest'
import { existsSyncMock, accessSyncMock, spawnMock } from './pty-ipc-mock-registry'
import { posixOnlyIt, makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerPtyHandlers } from './pty'
import { join } from 'node:path'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'

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
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  describe('hidden-at-spawn mark (initiallyHidden)', () => {
    // terminal-query-authority.md §races: hidden-at-spawn marks the PTY before byte one, closing the spawn-time DA1-loss window.
    function createRuntimeMock() {
      return {
        setPtyController: vi.fn(),
        registerPty: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn(() => 42),
        getPtyOutputSequence: vi.fn(() => 42),
        hasRemoteTerminalViewSubscriber: vi.fn(() => false),
        createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
        registerPreAllocatedHandleForPty: vi.fn()
      }
    }

    it('marks a daemon PTY hidden before spawn resolves so byte zero is gated', async () => {
      vi.useFakeTimers()
      const runtime = createRuntimeMock()
      const daemon = installObservableDaemonTestProvider()
      const spawnGate = makeDeferred()
      daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
        await spawnGate.promise
        return { id: options.sessionId ?? 'daemon-pty' }
      })
      try {
        registerPtyHandlers(mainWindow as never, runtime as never)
        const spawnPromise = handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session',
          initiallyHidden: true
        }) as Promise<{ id: string }>
        // Let the handler run up to the awaited provider.spawn.
        await Promise.resolve()
        mainWindow.webContents.send.mockClear()

        // Daemon PTYs can emit prompt bytes before spawn() resolves, so the pre-spawn mark must already gate them.
        expect(isHiddenRendererPty('daemon-session')).toBe(true)
        daemon.emitData('daemon-session', 'pre-spawn prompt\x1b[c')
        vi.advanceTimersByTime(50)
        expect(runtime.onPtyData).toHaveBeenCalledWith(
          'daemon-session',
          'pre-spawn prompt\x1b[c',
          expect.any(Number),
          'pre-spawn prompt\x1b[c'.length,
          undefined
        )
        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: 'daemon-session',
          reason: 'hidden-drop',
          markerSeq: 42
        })

        spawnGate.resolve()
        const result = await spawnPromise
        expect(isHiddenRendererPty(result.id)).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
    it('clears the pre-spawn hidden mark when the spawn fails', async () => {
      const daemon = installObservableDaemonTestProvider()
      daemon.spawn.mockRejectedValue(new Error('spawn exploded'))
      registerPtyHandlers(mainWindow as never)

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          sessionId: 'daemon-session',
          initiallyHidden: true
        })
      ).rejects.toThrow('spawn exploded')

      // A later visible attach reusing this session id must not start gated.
      expect(isHiddenRendererPty('daemon-session')).toBe(false)
    })
    it('marks local PTYs hidden after spawn, before their first data task', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          initiallyHidden: true
        })) as { id: string }
        mainWindow.webContents.send.mockClear()

        expect(isHiddenRendererPty(spawnResult.id)).toBe(true)
        mockProc.emitData('first chunk')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
          id: spawnResult.id,
          reason: 'hidden-drop'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('keeps spawns without the flag delivering to the renderer (visible unchanged)', async () => {
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)
      try {
        registerPtyHandlers(mainWindow as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        mainWindow.webContents.send.mockClear()

        expect(isHiddenRendererPty(spawnResult.id)).toBe(false)
        mockProc.emitData('visible output')
        vi.advanceTimersByTime(2)

        expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
          id: spawnResult.id,
          data: 'visible output'
        })
      } finally {
        vi.useRealTimers()
      }
    })
    it('answers DA1 from the model on the first chunk of a hidden-at-spawn PTY', async () => {
      // End-to-end through a REAL runtime: spawn-marked → first chunk dropped → emulator parses query → replies; main answers, the renderer never saw the bytes.
      const daemon = installObservableDaemonTestProvider()
      const runtime = new OrcaRuntimeService({
        getRepo: () => undefined,
        getRepos: () => [],
        addRepo: () => {},
        updateRepo: () => undefined as never,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => undefined as never,
        removeWorktreeMeta: () => {},
        getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
        getSettings: () => ({
          workspaceDir: '/tmp/workspaces',
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          terminalMainSideEffectAuthority: true,
          terminalHiddenDeliveryGate: true,
          terminalModelQueryAuthority: true
        })
      } as never)

      registerPtyHandlers(mainWindow as never, runtime as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session',
        initiallyHidden: true
      })) as { id: string }

      daemon.emitData(result.id, '\x1b[c')
      // Settle the per-PTY emulator writeChain (and the reply it forwards).
      await runtime.serializeMainTerminalBuffer(result.id)

      expect(daemon.write).toHaveBeenCalledWith(result.id, '\x1b[?1;2c')
    })
  })
  it('caps pending renderer delivery per PTY with oldest-drop and one restore marker', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      // 3 MB in one entry: the scrollback-scaled cap (2 MB default) drops to O(1) memory; one restore marker fires, droppedOutput routes to the snapshot repaint.
      mockProc.emitData('x'.repeat(1024 * 1024) + 'y'.repeat(2 * 1024 * 1024))

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: spawnResult.id,
        reason: 'pending-cap'
      })

      // A second overflow before the entry drains must not re-mark.
      mockProc.emitData('z'.repeat(64 * 1024))
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
        id: spawnResult.id,
        data: '',
        droppedOutput: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([
    ['terminalHiddenDeliveryGate', { terminalHiddenDeliveryGate: false }],
    ['terminalMainSideEffectAuthority', { terminalMainSideEffectAuthority: false }]
  ])(
    'keeps the pending cap active without a restore marker when the %s kill switch is off',
    async (_name, settings) => {
      // Why: the pending cap ships independently of the gate (#7150) — droppedOutput repaint survives kill switches; only the restore marker is switch-scoped.
      vi.useFakeTimers()
      const mockProc = createMockProc()
      spawnMock.mockReturnValue(mockProc.proc)

      try {
        registerPtyHandlers(mainWindow as never, undefined, undefined, (() => settings) as never)
        const spawnResult = (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })) as { id: string }
        mainWindow.webContents.send.mockClear()

        mockProc.emitData('x'.repeat(3 * 1024 * 1024))

        expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
          'pty:modelRestoreNeeded',
          expect.anything()
        )

        vi.advanceTimersByTime(2)
        expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:data', {
          id: spawnResult.id,
          data: '',
          droppedOutput: true
        })
      } finally {
        vi.useRealTimers()
      }
    }
  )
  it('batches stale PTY output after the interactive window expires', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      vi.advanceTimersByTime(101)
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('stale redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'stale redraw'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  posixOnlyIt('falls back to a system shell when SHELL points to a missing binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    existsSyncMock.mockImplementation(
      (targetPath: string) => targetPath !== '/opt/homebrew/bin/bash'
    )

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId: 'repo-1::/tmp'
      })

      expect(result).toEqual({
        id: expect.any(String),
        pid: 12345,
        incarnationId: expect.any(String)
      })
      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({ cwd: '/tmp' })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Primary shell "/opt/homebrew/bin/bash" failed')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })
  posixOnlyIt('falls back when SHELL points to a non-executable binary', async () => {
    const originalShell = process.env.SHELL
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    accessSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '/opt/homebrew/bin/bash') {
        throw new Error('permission denied')
      }
    })

    try {
      process.env.SHELL = '/opt/homebrew/bin/bash'

      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId: 'repo-1::/tmp'
      })

      expect(spawnMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-l'],
        expect.objectContaining({
          cwd: '/tmp',
          env: expect.objectContaining({
            ORCA_OPENCODE_CONFIG_DIR: '/tmp/orca-opencode-config',
            // No `ready`: the fallback shell carries an overlay, not a startup command.
            ORCA_SHELL_FEATURES: 'overlay,history,markers',
            ZDOTDIR: join(getShellReadyWrapperRoot(), 'zsh')
          })
        })
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shell "/opt/homebrew/bin/bash" is not executable')
      )
    } finally {
      warnSpy.mockRestore()
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })
})
