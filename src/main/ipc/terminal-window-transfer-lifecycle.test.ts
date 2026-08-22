import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { TerminalWindowTransferCoordinatorOptions } from './terminal-window-transfer-coordinator-options'
import {
  createTerminalWindowTransferHarness,
  ipcEvent,
  terminalWindowSeed,
  terminalWindowSession,
  type TerminalWindowTransferHarness
} from './terminal-window-transfer-test-fixture'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  screen: {
    getCursorScreenPoint: vi.fn(),
    getDisplayNearestPoint: vi.fn()
  }
}))

vi.mock('./pty', () => ({
  handoffPtyRendererOwnership: vi.fn(),
  registerPtyRenderer: vi.fn(),
  sendToPtyOwner: vi.fn()
}))

vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))

async function createCoordinator(
  h: TerminalWindowTransferHarness,
  overrides: Partial<TerminalWindowTransferCoordinatorOptions> = {}
) {
  const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
  return new TerminalWindowTransferCoordinator({
    store: {} as never,
    createSecondaryWindow: () => {
      h.windows.register(h.target as never, 'secondary')
      return h.target as never
    },
    windows: h.windows,
    sessions: h.sessions as never,
    owners: h.owners,
    getCursorPoint: () => ({ x: 700, y: 100 }),
    getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    handoff: h.handoff,
    timeoutMs: 20,
    ...overrides
  })
}

function configureCreatedTarget(h: TerminalWindowTransferHarness): void {
  h.records.delete(h.target.id)
  h.owners.removeRenderer(h.target.webContents as never)
  h.sessions.seedWindow.mockImplementation((windowId, sessions) => {
    h.records.set(windowId, structuredClone([...sessions.values()].at(-1)!))
  })
  h.sessions.retire.mockImplementation((windowId) => {
    h.records.delete(windowId)
  })
}

function expectCreatedTargetClean(
  h: TerminalWindowTransferHarness,
  targetRenderer: WebContents
): void {
  expect(h.target.destroy).toHaveBeenCalledOnce()
  expect(h.sessions.retire).toHaveBeenCalledWith(h.target.id, 'empty-close')
  expect(h.records.has(h.target.id)).toBe(false)
  expect(h.owners.isRegistered(targetRenderer)).toBe(false)
}

describe('terminal window transfer lifecycle recovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('cleans a created target when renderer registration throws', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    const targetRenderer = h.target.webContents as never
    configureCreatedTarget(h)
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        throw new Error('register_boom')
      }
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'register_boom' })
    expectCreatedTargetClean(h, targetRenderer)
  })

  it('uses the exact disposer when created-target session seeding throws', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    const targetRenderer = h.target.webContents as never
    configureCreatedTarget(h)
    const dispose = vi.fn(() => h.owners.removeRenderer(h.target.webContents as never))
    h.sessions.seedWindow.mockImplementation(() => {
      throw new Error('seed_boom')
    })
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        return dispose
      }
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'seed_boom' })
    expect(dispose).toHaveBeenCalledOnce()
    expectCreatedTargetClean(h, targetRenderer)
  })

  it('cleans backing when initial target set mutates before throwing', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    const targetRenderer = h.target.webContents as never
    configureCreatedTarget(h)
    h.sessions.set.mockImplementation((windowId, state) => {
      h.records.set(windowId, structuredClone(state))
      throw new Error('stage_persist_boom')
    })
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        return () => h.owners.removeRenderer(h.target.webContents as never)
      }
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'stage_persist_boom' })
    expectCreatedTargetClean(h, targetRenderer)
  })

  it('forward-commits to a live target when the source window closes after handoff', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h, { createSecondaryWindow: vi.fn() })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation((_channel, command) => {
      h.source.emit('close')
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: false,
          error: 'target_import_boom'
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
    expect(h.records.get(h.source.id)?.tabsByWorktree['wt-1'] ?? []).toEqual([])
    expect(h.records.get(h.target.id)?.tabsByWorktree['wt-1']?.[0]).toEqual(
      terminalWindowSeed().tab
    )
    expect(h.records.get(h.target.id)?.terminalLayoutsByTabId['tab-1']).toEqual(
      terminalWindowSeed().layout
    )
  })

  it('forward-commits when the source renderer disappears during source removal', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h, { createSecondaryWindow: vi.fn() })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })
    h.source.webContents.send.mockImplementation(() => {
      h.source.webContents.destroyed = true
      h.source.webContents.emit('render-process-gone')
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
    expect(h.records.get(h.source.id)?.tabsByWorktree['wt-1'] ?? []).toEqual([])
    expect(h.records.get(h.target.id)?.tabsByWorktree['wt-1']?.[0]).toEqual(
      terminalWindowSeed().tab
    )
  })

  it('hands ownership back to an exact live source when the target closes', async () => {
    const h = createTerminalWindowTransferHarness()
    const coordinator = await createCoordinator(h, { createSecondaryWindow: vi.fn() })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation(() => h.target.emit('close'))

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target_lost' })
    expect(h.owners.owns('pty-1', h.source.webContents as never)).toBe(true)
    expect(h.records.get(h.source.id)).toEqual(terminalWindowSession(true))
    expect(h.records.get(h.target.id)).toEqual(terminalWindowSession(false))
  })

  it('keeps source durable backing if target loss cannot hand ownership back', async () => {
    const h = createTerminalWindowTransferHarness()
    let handoffCount = 0
    const coordinator = await createCoordinator(h, {
      createSecondaryWindow: vi.fn(),
      handoff: (ids, from, to) => {
        if (++handoffCount > 1) {
          throw new Error('handoff_back_boom')
        }
        h.handoff(ids, from, to)
      }
    })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation(() => h.target.emit('close'))

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target_lost' })
    expect(h.records.get(h.source.id)?.tabsByWorktree['wt-1']?.[0]).toEqual(
      terminalWindowSeed().tab
    )
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
  })
})
