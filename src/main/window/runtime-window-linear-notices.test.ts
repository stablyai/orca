import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RuntimeClientEventBus } from '../runtime/client/events/runtime-client-event-bus'
import { OrcaRuntimeWithApplyTrackedPtyTitle } from '../runtime/terminal/output/terminal-title-observation'

const { ipcMain, flags } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter(), flags: { sidebar: false } }
})
vi.mock('electron', () => ({ ipcMain }))
vi.mock('../../shared/sidebar-inputs-switch', () => ({
  get ORCA_SIDEBAR_INPUTS_IS_MAIN() {
    return flags.sidebar
  }
}))
vi.mock('../ipc/worktrees/listing/worktree-change-invalidators', () => ({
  runWorktreeChangeInvalidators: vi.fn()
}))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))
import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'
afterEach(() => {
  ipcMain.removeAllListeners()
  flags.sidebar = false
})

abstract class TerminalScanningProbe extends OrcaRuntimeWithApplyTrackedPtyTitle {
  public refreshScanningAvailability(): void {
    super.refreshTerminalSideEffectConsumerAvailability()
  }
  public setScanningAvailable(value: boolean): void {
    super.setTerminalSideEffectConsumerAvailable(value)
  }
}

it.each([100, 1000])(
  'forwards only Linear notifications and releases its window at %i producers',
  (population) => {
    const trackers = Array.from({ length: population }, () => ({
      tracker: { setTransientSideEffectScanningEnabled: vi.fn() },
      commandCodeDetector: null
    }))
    const state = {
      terminalSideEffectLocalConsumerAvailable: false,
      terminalSideEffectConsumerAvailable: false,
      onTerminalSideEffects: () => {},
      ptyTitleTrackersByPtyId: new Map(trackers.map((tracker, i) => [String(i), tracker])),
      createTerminalSideEffectCommandCodeDetector: vi.fn(() => ({})),
      countTerminalSideEffectConsumingClientEventListeners: () =>
        bus.countTerminalSideEffectConsumers(),
      refreshTerminalSideEffectConsumerAvailability: () =>
        TerminalScanningProbe.prototype.refreshScanningAvailability.call(probe)
    }
    const bus = new RuntimeClientEventBus({
      makeTitleGateKey: (raw) => raw,
      onConsumerAvailabilityChanged: () => state.refreshTerminalSideEffectConsumerAvailability()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these public test wrappers run only the production availability methods over their installed tracker/consumer fields.
    const probe = state as unknown as TerminalScanningProbe
    const available = (value: boolean) =>
      TerminalScanningProbe.prototype.setScanningAvailable.call(probe, value)
    const events = new EventEmitter()
    const send = vi.fn()
    const webContents = { on: vi.fn(), isDestroyed: () => false, send }
    const window = { id: 1, on: events.on.bind(events), isDestroyed: () => false, webContents }
    const runtime = {
      attachWindow: vi.fn(),
      setNotifier: vi.fn(),
      onClientEvent: bus.on.bind(bus),
      setAgentListPublication: vi.fn(),
      markGraphUnavailable: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the window registration's lifecycle and notification ports.
    registerRuntimeWindowLifecycle(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only the installed window lifecycle and notification ports.
      window as unknown as BrowserWindow,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration exercises only these installed runtime event, graph and notifier ports.
      runtime as unknown as OrcaRuntimeService
    )
    expect(bus.countTerminalSideEffectConsumers()).toBe(0)
    available(true)
    available(false)
    expect(state.terminalSideEffectConsumerAvailable).toBe(false)
    expect(
      trackers.every(
        (entry) => entry.tracker.setTransientSideEffectScanningEnabled.mock.lastCall?.[0] === false
      )
    ).toBe(true)
    for (let i = 0; i < population; i += 1) {
      bus.emit({ type: 'worktreesChanged', repoId: String(i) })
    }
    expect(send).toHaveBeenCalledTimes(0)
    const update = {
      type: 'linearLinkedIssueUpdated' as const,
      worktreeId: 'wt',
      identifier: 'ENG-1',
      workspaceId: 'w1'
    }
    bus.emit(update)
    expect(send.mock.calls).toEqual([['linear:linkedIssueUpdated', update]])
    events.emit('closed')
    bus.emit(update)
    expect(send).toHaveBeenCalledTimes(1)
    expect(bus.countTerminalSideEffectConsumers()).toBe(0)
  }
)

it.each([false, true])('preserves the sidebar switch=%s beside Linear notices', (enabled) => {
  flags.sidebar = enabled
  const events = new EventEmitter()
  const send = vi.fn()
  const bus = new RuntimeClientEventBus({
    makeTitleGateKey: (raw) => raw,
    onConsumerAvailabilityChanged: () => {}
  })
  const runtime = {
    attachWindow: vi.fn(),
    setNotifier: vi.fn(),
    onClientEvent: bus.on.bind(bus),
    setAgentListPublication: vi.fn(),
    markGraphUnavailable: vi.fn()
  }
  const window = {
    id: 2,
    on: events.on.bind(events),
    isDestroyed: () => false,
    webContents: { on: vi.fn(), isDestroyed: () => false, send }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the installed lifecycle/notification ports are exercised.
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the installed window lifecycle and webContents ports are read.
    window as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration exercises only these fixture runtime event and notifier ports.
    runtime as unknown as OrcaRuntimeService
  )
  const event = { type: 'sidebarInputsChanged' as const, generation: 'g', revision: 1 }
  bus.emit(event)
  expect(send.mock.calls).toEqual(enabled ? [['runtime:sidebarInputsChanged', event]] : [])
  events.emit('closed')
})
