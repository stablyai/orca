import { localProvider } from './pty/provider/registry'
import { spawnForStablePane } from './pty/pane/stable-owner'
import { prepareDaemonPtySpawnImages } from './pty/pty-spawn-image-calibration'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import raster from '../../shared/__fixtures__/terminal-raster-red.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { store } from '../runtime/orca-runtime-test-fixtures.spec'
import {
  CHECKPOINT_THEME,
  kittyImage,
  MODEL_BUDGET
} from '../runtime/headless-model-checkpoint-test-fixture'
import { setTerminalViewAttributes } from '../runtime/terminal-view-attribute-store'
import type { PtySpawnOptions } from '../providers/types'

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

const commands = [
  ['Kitty', kittyImage()],
  ['IIP', `\x1b]1337;File=inline=1;width=2;height=1;preserveAspectRatio=0:${raster.png}\x07`],
  ['SIXEL', '\x1bPq"1;1;6;6#1;2;100;0;0#1!6~\x1b\\']
] as const

const spawnCases = commands.flatMap(([protocol, command]) =>
  ['ipc', 'runtime'].map((source) => [source, protocol, command] as const)
)
const cellSize = { width: 9.025, height: 18 }
const runtimes: { runtime: OrcaRuntimeService; id: string }[] = []
afterEach(() => {
  for (const { runtime, id } of runtimes.splice(0)) {
    runtime.onPtyExit(id, 0, undefined, { providerExitObserved: true })
  }
})

describe('initial inline image model admission', () => {
  const { handlers, mainWindow, createMockProc, installObservableDaemonTestProvider } =
    setupPtyIpcSuite()
  function register(runtime: OrcaRuntimeService, enabled = true) {
    handlers.clear()
    const installed = vi.spyOn(runtime, 'setPtyController')
    registerPtyHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared harness supplies the BrowserWindow methods exercised by these handlers.
      mainWindow as Parameters<typeof registerPtyHandlers>[0],
      runtime,
      undefined,
      () => createGlobalSettingsFixture({ terminalInlineImages: enabled })
    )
    setTerminalViewAttributes(CHECKPOINT_THEME)
    const controller = installed.mock.calls.at(-1)?.[0]
    if (!controller?.spawn) {
      throw new Error('Expected runtime spawn controller')
    }
    return controller
  }

  async function assertModel(runtime: OrcaRuntimeService, id: string) {
    const capture = await runtime.captureHeadlessTerminalModelCheckpoint(id, MODEL_BUDGET)
    if (!capture) {
      throw new Error('Expected complete model')
    }
    try {
      expect(capture.checkpoint.metadata.configuration).toMatchObject({
        cols: 40,
        rows: 18,
        images: { cellSize }
      })
      expect(
        capture.checkpoint.metadata.graphics.components.find((part) => part.kind === 'decoded')
          ?.metadata
      ).toMatchObject({ images: [{ origCellSize: cellSize }] })
    } finally {
      capture.dispose()
    }
  }

  it.each(spawnCases)(
    '%s initializes native %s output before the first onData callback',
    async (source, _protocol, command) => {
      const runtime = new OrcaRuntimeService(store)
      const { proc } = createMockProc()
      proc.onData.mockImplementationOnce((accept: (data: string) => void) => {
        accept(command)
        return { dispose() {} }
      })
      spawnMock.mockReturnValueOnce(proc)
      const controller = register(runtime)
      const request = { cols: 40, rows: 18, terminalImageCellSize: cellSize }
      const result =
        source === 'runtime'
          ? await controller.spawn?.(request)
          : await handlers.get('pty:spawn')!(null, request)
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string'
      ) {
        throw new Error('Expected spawn result')
      }
      runtimes.push({ runtime, id: result.id })
      await assertModel(runtime, result.id)
    }
  )

  it.each(spawnCases)(
    '%s initializes daemon %s output before the provider spawn reply',
    async (source, _protocol, command) => {
      const runtime = new OrcaRuntimeService(store)
      const provider = installObservableDaemonTestProvider()
      provider.spawn.mockImplementation(async (options: PtySpawnOptions) => {
        if (!options.sessionId) {
          throw new Error('Expected preallocated daemon id')
        }
        provider.emitData(options.sessionId, command)
        return { id: options.sessionId }
      })
      const controller = register(runtime)
      const request = { cols: 40, rows: 18, terminalImageCellSize: cellSize }
      const result =
        source === 'runtime'
          ? await controller.spawn?.(request)
          : await handlers.get('pty:spawn')!(null, request)
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string'
      ) {
        throw new Error('Expected spawn result')
      }
      runtimes.push({ runtime, id: result.id })
      await assertModel(runtime, result.id)
    }
  )
  it.each([
    ['disabled', false, cellSize],
    ['zero cell', true, { width: 0, height: 18 }],
    ['infinite cell', true, { width: Infinity, height: 18 }],
    ['untyped cell', true, { width: '9', height: 18 }]
  ])(
    'declines %s calibration without losing the first output',
    async (_label, enabled, terminalImageCellSize) => {
      const runtime = new OrcaRuntimeService(store)
      const provider = installObservableDaemonTestProvider()
      provider.spawn.mockImplementation(async (options: PtySpawnOptions) => {
        if (!options.sessionId) {
          throw new Error('Expected daemon id')
        }
        provider.emitData(options.sessionId, `TEXT BEFORE IMAGE${kittyImage()}`)
        return { id: options.sessionId }
      })
      register(runtime, enabled)
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 40,
        rows: 18,
        terminalImageCellSize
      })
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string'
      ) {
        throw new Error('Expected spawn result')
      }
      runtimes.push({ runtime, id: result.id })
      await expect(
        runtime.captureHeadlessTerminalModelCheckpoint(result.id, MODEL_BUDGET)
      ).rejects.toThrow('image support is not configured')
      const text = await runtime.serializeTerminalBuffer(result.id)
      expect(text?.data).toContain('TEXT BEFORE IMAGE')
      expect(provider.spawn.mock.calls[0]?.[0]).not.toHaveProperty('terminalImageCellSize')
    }
  )
  it('prepares images only after a missing stable owner falls through to fresh dispatch', async () => {
    const runtime = new OrcaRuntimeService(store)
    const provider = installObservableDaemonTestProvider()
    const options = {
      cols: 40,
      rows: 18,
      sessionId: 'fresh-after-absence',
      terminalImageCellSize: cellSize
    }
    provider.spawn.mockRejectedValueOnce(new SessionNotFoundError('old-owner'))
    provider.spawn.mockImplementationOnce(async (spawn: PtySpawnOptions) => {
      if (!spawn.sessionId) {
        throw new Error('Expected fresh id')
      }
      provider.emitData(spawn.sessionId, kittyImage())
      return { id: spawn.sessionId }
    })
    register(runtime)
    const prepare = vi.fn(() =>
      prepareDaemonPtySpawnImages(runtime, options.sessionId, null, options, true)
    )
    const result = await spawnForStablePane({
      runtime,
      provider: localProvider,
      owner: { ptyId: 'old-owner', tabId: 'old-tab', leafId: 'old-leaf' },
      spawnOptions: options,
      onBeforeFreshSpawn: prepare
    })
    runtimes.push({ runtime, id: result.result.id })
    expect(prepare).toHaveBeenCalledOnce()
    expect(provider.spawn).toHaveBeenCalledTimes(2)
    await assertModel(runtime, result.result.id)
  })

  it('does not allocate an image model when stable-owner attachment wins', async () => {
    const runtime = new OrcaRuntimeService(store)
    const provider = installObservableDaemonTestProvider()
    provider.spawn.mockResolvedValueOnce({ id: 'existing-owner', isReattach: true })
    const options = {
      cols: 40,
      rows: 18,
      sessionId: 'unused-provisional',
      terminalImageCellSize: cellSize
    }
    register(runtime)
    const prepare = vi.fn(() =>
      prepareDaemonPtySpawnImages(runtime, options.sessionId, null, options, true)
    )
    await spawnForStablePane({
      runtime,
      provider: localProvider,
      owner: { ptyId: 'existing-owner', tabId: 'existing-tab', leafId: 'existing-leaf' },
      spawnOptions: options,
      onBeforeFreshSpawn: prepare
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(
      await runtime.captureHeadlessTerminalModelCheckpoint(options.sessionId, MODEL_BUDGET)
    ).toBeNull()
  })
})
