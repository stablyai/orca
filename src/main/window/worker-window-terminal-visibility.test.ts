import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../runtime/device-registry'
import { LocalWindowTerminalGrids } from '../runtime/local-window-terminal-grids'
import {
  reportHostTerminalWindowLease,
  reportWorkerTerminalWindowLease,
  resolveWorkerTerminalWindow,
  trackTerminalWindow,
  trackWorkerTerminalWindow,
  type WindowTerminalRuntime
} from './worker-window-terminal-visibility'

const PTY = 'shared-pty'
const OTHER_PTY = 'unrelated-pty'
const GRID = { cols: 132, rows: 42 }
const directories: string[] = []

class NativeWindowFixture extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), { mainFrame: {} })
  visible = true
  minimized = false
  destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isVisible() {
    return this.visible
  }

  isMinimized() {
    return this.minimized
  }

  isDestroyed() {
    return this.destroyed
  }

  get nativeWindow(): BrowserWindow {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tracking reads only id, native visibility methods and EventEmitter lifecycle methods implemented by this fixture and its webContents.
    return this as unknown as BrowserWindow
  }

  hide(): void {
    this.visible = false
    this.emit('hide')
  }

  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-window-visibility-'))
  directories.push(directory)
  const registry = new DeviceRegistry(directory)
  const grids = new LocalWindowTerminalGrids({
    getTerminalSize: () => GRID,
    onChange: () => {}
  })
  const runtime: WindowTerminalRuntime = {
    setLocalTerminalWindowVisible: (windowId, visible) => grids.setWindowVisible(windowId, visible),
    removeLocalTerminalWindow: (windowId) => grids.removeWindow(windowId),
    setLocalTerminalWindowLease: (ptyId, leaseKey, windowId, visible) =>
      grids.setLease(ptyId, leaseKey, windowId, visible),
    removeLocalTerminalWindowLease: (ptyId, leaseKey) => grids.removeLease(ptyId, leaseKey)
  }
  const host = new NativeWindowFixture(1)
  trackTerminalWindow(runtime, host.nativeWindow)
  runtime.setLocalTerminalWindowLease(PTY, 'host:1', host.id, true)
  return {
    grids,
    runtime,
    registry,
    host,
    addWorker(windowId: number) {
      const root = registry.addDevice(`Worker ${windowId}`, 'runtime', 'this-computer', [], {
        dedicated: true
      })
      const window = new NativeWindowFixture(windowId)
      trackWorkerTerminalWindow(runtime, window.nativeWindow, root.deviceId, () =>
        registry.listDevices()
      )
      const binding = resolveWorkerTerminalWindow(runtime, root.deviceId)
      if (!binding) {
        throw new Error('Registered worker root did not resolve')
      }
      return { window, root, binding }
    }
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('native worker terminal visibility identity and lifetime', () => {
  it('rejects host reports from an outgoing document before and after replacement DOM admission', () => {
    const { grids, runtime, host, addWorker } = createHarness()
    const worker = addWorker(2)
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'worker:2', true)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    const oldFrame = host.nativeWindow.webContents.mainFrame
    host.webContents.emit('did-start-navigation', {}, 'file:///replacement', false, true)
    reportHostTerminalWindowLease(runtime, host.nativeWindow.webContents, PTY, true, oldFrame)
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    host.webContents.mainFrame = {}
    host.webContents.emit('dom-ready')
    reportHostTerminalWindowLease(runtime, host.nativeWindow.webContents, PTY, true, oldFrame)
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    reportHostTerminalWindowLease(
      runtime,
      host.nativeWindow.webContents,
      PTY,
      true,
      host.nativeWindow.webContents.mainFrame
    )
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
  })

  it('admits the registered bootstrap root and its real browser-key fork, excluding ordinary devices', () => {
    const { grids, runtime, registry, addWorker } = createHarness()
    const worker = addWorker(2)
    const ordinary = registry.addDevice('Ordinary paired desktop', 'runtime')
    const ordinaryKey = registry.forkDeviceKey(
      ordinary.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Ordinary browser'
    )
    for (const deviceId of [undefined, 'unknown-device', ordinary.deviceId, ordinaryKey.deviceId]) {
      const binding = resolveWorkerTerminalWindow(runtime, deviceId)
      expect(binding).toBeUndefined()
      reportWorkerTerminalWindowLease(runtime, binding, PTY, `untrusted:${deviceId}`, true)
      expect(grids.getPinnedGrid(PTY)).toBeNull()
      expect(grids.getVisibleLeases(PTY)).toEqual([{ windowId: 1, leaseKey: 'host:1' }])
    }

    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'bootstrap-stream', false)
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'bootstrap-stream', true)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    runtime.removeLocalTerminalWindowLease(PTY, 'bootstrap-stream')
    expect(grids.getPinnedGrid(PTY)).toBeNull()

    const browserKey = registry.forkDeviceKey(
      worker.root.deviceId,
      Buffer.alloc(32, 2).toString('base64'),
      'Worker browser',
      { ephemeral: true }
    )
    const keyedBinding = resolveWorkerTerminalWindow(runtime, browserKey.deviceId)
    expect(keyedBinding).toEqual(worker.binding)
    reportWorkerTerminalWindowLease(runtime, keyedBinding, PTY, 'browser-key-stream', true)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
  })

  it('does not resolve another runtime installation or recreate a revoked worker credential', () => {
    const first = createHarness()
    const worker = first.addWorker(2)
    const second = createHarness()
    second.addWorker(2)
    const foreignBinding = resolveWorkerTerminalWindow(second.runtime, worker.root.deviceId)
    expect(foreignBinding).toBeUndefined()
    reportWorkerTerminalWindowLease(second.runtime, foreignBinding, PTY, 'foreign-stream', true)
    expect(second.grids.getPinnedGrid(PTY)).toBeNull()

    first.registry.removeDevice(worker.root.deviceId)
    const revokedBinding = resolveWorkerTerminalWindow(first.runtime, worker.root.deviceId)
    expect(revokedBinding).toBeUndefined()
    reportWorkerTerminalWindowLease(first.runtime, revokedBinding, PTY, 'revoked-stream', true)
    expect(first.grids.getPinnedGrid(PTY)).toBeNull()
  })

  it('fences reports from the previous main-frame document while preserving subframe and hash navigation', () => {
    const { grids, runtime, addWorker } = createHarness()
    const worker = addWorker(2)
    const sibling = addWorker(3)
    runtime.setLocalTerminalWindowLease(OTHER_PTY, 'host-other', 1, true)
    reportWorkerTerminalWindowLease(runtime, sibling.binding, OTHER_PTY, 'sibling-stream', true)
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'old-stream', true)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)

    worker.window.webContents.emit('did-start-navigation', {}, 'https://local/#tab', true, true)
    worker.window.webContents.emit('did-start-navigation', {}, 'https://local/frame', false, false)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    worker.window.webContents.emit('did-start-navigation', {}, 'https://local/reload', false, true)
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    expect(grids.getPinnedGrid(OTHER_PTY)).toEqual(GRID)
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'old-stream', true)
    expect(grids.getVisibleLeases(PTY)).toEqual([{ windowId: 1, leaseKey: 'host:1' }])

    const nextBinding = resolveWorkerTerminalWindow(runtime, worker.root.deviceId)
    expect(nextBinding).toEqual({ windowId: 2, generation: worker.binding.generation + 1 })
    reportWorkerTerminalWindowLease(runtime, nextBinding, PTY, 'new-stream', true)
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'new-stream', false)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    expect(grids.getVisibleLeases(PTY)).toContainEqual({ windowId: 2, leaseKey: 'new-stream' })
  })

  it.each(['hide', 'minimize', 'crash', 'close'] as const)(
    '%s releases only the affected window and rejects its stale visibility',
    (event) => {
      const { grids, runtime, addWorker } = createHarness()
      const worker = addWorker(2)
      const sibling = addWorker(3)
      runtime.setLocalTerminalWindowLease(OTHER_PTY, 'host-other', 1, true)
      reportWorkerTerminalWindowLease(runtime, sibling.binding, OTHER_PTY, 'sibling-stream', true)
      reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'worker-stream', true)
      expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
      if (event === 'hide') {
        worker.window.hide()
      } else if (event === 'minimize') {
        worker.window.minimized = true
        worker.window.emit('minimize')
      } else if (event === 'crash') {
        worker.window.webContents.emit('render-process-gone')
      } else {
        worker.window.close()
      }
      reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'worker-stream', true)
      expect(grids.getPinnedGrid(PTY)).toBeNull()
      expect(grids.getVisibleLeases(PTY)).toEqual([{ windowId: 1, leaseKey: 'host:1' }])
      expect(grids.getPinnedGrid(OTHER_PTY)).toEqual(GRID)

      if (event === 'hide' || event === 'minimize') {
        worker.window.visible = true
        worker.window.minimized = false
        worker.window.emit(event === 'hide' ? 'show' : 'restore')
        expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
      } else if (event === 'crash') {
        const recoveredBinding = resolveWorkerTerminalWindow(runtime, worker.root.deviceId)
        expect(recoveredBinding?.generation).toBe(worker.binding.generation + 1)
        reportWorkerTerminalWindowLease(runtime, recoveredBinding, PTY, 'recovered-stream', true)
        expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
      } else {
        expect(resolveWorkerTerminalWindow(runtime, worker.root.deviceId)).toBeUndefined()
      }
    }
  )

  it('counts overlapping streams from one worker once and lets the replacement stream survive detach', () => {
    const { grids, runtime, registry, host, addWorker } = createHarness()
    const worker = addWorker(2)
    const browserKey = registry.forkDeviceKey(
      worker.root.deviceId,
      Buffer.alloc(32, 3).toString('base64'),
      'Worker reconnect',
      { ephemeral: true }
    )
    runtime.removeLocalTerminalWindowLease(PTY, 'host:1')
    reportWorkerTerminalWindowLease(runtime, worker.binding, PTY, 'old-stream', true)
    reportWorkerTerminalWindowLease(
      runtime,
      resolveWorkerTerminalWindow(runtime, browserKey.deviceId),
      PTY,
      'replacement-stream',
      true
    )
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    runtime.setLocalTerminalWindowLease(PTY, 'host:1', host.id, true)
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    runtime.removeLocalTerminalWindowLease(PTY, 'old-stream')
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    expect(grids.getVisibleLeases(PTY)).toContainEqual({
      windowId: 2,
      leaseKey: 'replacement-stream'
    })
  })

  it('does not give a hidden host a pin after one of its two visible workers closes', () => {
    const { grids, runtime, host, addWorker } = createHarness()
    const first = addWorker(2)
    const second = addWorker(3)
    reportWorkerTerminalWindowLease(runtime, first.binding, PTY, 'first-stream', true)
    reportWorkerTerminalWindowLease(runtime, second.binding, PTY, 'second-stream', true)
    host.hide()
    expect(grids.getPinnedGrid(PTY)).toEqual(GRID)
    expect(grids.getVisibleLeases(PTY).map((lease) => lease.windowId)).toEqual([2, 3])

    first.window.close()
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    expect(grids.getVisibleLeases(PTY)).toEqual([{ windowId: 3, leaseKey: 'second-stream' }])
    reportWorkerTerminalWindowLease(runtime, first.binding, PTY, 'late-stream', true)
    expect(grids.getPinnedGrid(PTY)).toBeNull()
    reportWorkerTerminalWindowLease(runtime, second.binding, PTY, 'second-stream', false)
    expect(grids.getVisibleLeases(PTY)).toEqual([])
  })
})
