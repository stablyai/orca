import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'

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

// A query's reply owner is fixed when main ingests the chunk: the view when its delivery mode is
// 'parse', main's model otherwise. These pin that a visibility flip while the chunk is still queued
// never leaves the query unanswered or answered twice.
describe('PTY query replies across a visibility flip', () => {
  const {
    handlers,
    mainWindow,
    createMockProc,
    getPtySetHiddenRendererPtyListener,
    getPtySetDeliveryInterestListener
  } = setupPtyIpcSuite()

  async function spawnPty(): Promise<{
    id: string
    emitData: (data: string) => void
    setHidden: (hidden: boolean) => void
    setInterest: (interested: boolean) => void
  }> {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    // The suite's window mock stands in for a BrowserWindow.
    Reflect.apply(registerPtyHandlers, undefined, [mainWindow])
    const spawned: unknown = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp'
    })
    if (typeof spawned !== 'object' || !spawned || !('id' in spawned)) {
      throw new Error('pty:spawn returned no id')
    }
    const id = String(spawned.id)
    const setHidden = getPtySetHiddenRendererPtyListener()
    const setInterest = getPtySetDeliveryInterestListener()
    mainWindow.webContents.send.mockClear()
    return {
      id,
      emitData: mockProc.emitData,
      setHidden: (hidden) => setHidden(null, { id, hidden }),
      setInterest: (interested) => setInterest(null, { id, interested })
    }
  }

  function dataSends(): unknown[] {
    return mainWindow.webContents.send.mock.calls
      .filter((call: unknown[]) => call[0] === 'pty:data')
      .map((call: unknown[]) => call[1])
  }

  it('hands the view the queries it still owed when the pane hides before the flush', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.emitData('prompt\x1b[6n')
      expect(dataSends()).toEqual([])

      pty.setHidden(true)
      vi.advanceTimersByTime(50)

      expect(dataSends()).toEqual([
        { id: pty.id, data: '\x1b[6n', droppedOutput: true, background: true }
      ])
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
        id: pty.id,
        reason: 'hidden-drop'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the view its queries when queued bytes go to sidecars only after a hide', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.emitData('prompt\x1b[6n')
      pty.setInterest(true)
      pty.setHidden(true)
      vi.advanceTimersByTime(50)

      expect(dataSends()).toEqual([
        { id: pty.id, data: '\x1b[6n', droppedOutput: true, background: true },
        { id: pty.id, data: 'prompt\x1b[6n', sidecarOnly: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers once when the pane hides with a sidecar attached and more bytes follow', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.emitData('prompt\x1b[6n')
      pty.setInterest(true)
      pty.setHidden(true)
      pty.emitData('\x1b[c')
      vi.advanceTimersByTime(50)

      // The view owed only the first query; main's model answered the DA1 sent while gated.
      expect(dataSends()).toEqual([
        { id: pty.id, data: '\x1b[6n', droppedOutput: true, background: true },
        { id: pty.id, data: 'prompt\x1b[6n\x1b[c', sidecarOnly: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops queued bytes main answered without handing their queries back when the sidecar leaves', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.setHidden(true)
      pty.setInterest(true)
      pty.emitData('agent\x1b[6n')
      // Still hidden: the mode moves from sidecars-only to drop, but main owns the replies either way.
      pty.setInterest(false)
      vi.advanceTimersByTime(50)

      expect(dataSends()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps bytes main answered away from the view when the pane is revealed before the flush', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.setHidden(true)
      pty.setInterest(true)
      pty.emitData('agent\x1b[6n')
      pty.setHidden(false)
      vi.advanceTimersByTime(50)

      expect(dataSends()).toEqual([{ id: pty.id, data: 'agent\x1b[6n', sidecarOnly: true }])
      // The view skipped them, so it repaints from main's model.
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: pty.id,
        reason: 'hidden-drop'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends gated bytes to sidecars before the first output after a reveal', async () => {
    vi.useFakeTimers()
    try {
      const pty = await spawnPty()
      pty.setHidden(true)
      pty.setInterest(true)
      pty.emitData('agent\x1b[6n')
      pty.setHidden(false)
      pty.emitData('fresh')
      vi.advanceTimersByTime(50)

      expect(dataSends()).toEqual([
        { id: pty.id, data: 'agent\x1b[6n', sidecarOnly: true },
        { id: pty.id, data: 'fresh' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
