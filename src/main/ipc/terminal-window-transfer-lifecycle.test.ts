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

  it('does not forward-commit when the target closes during source-loss import recovery', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    configureCreatedTarget(h)
    let importAttempts = 0
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        return () => h.owners.removeRenderer(h.target.webContents as never)
      },
      loadWindow: () => {
        h.owners.markDispatcherReady(h.target.webContents as never)
        coordinator.getContext(ipcEvent(h.target.webContents) as never)
      }
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import') {
        importAttempts += 1
        if (importAttempts === 1) {
          h.source.emit('close')
        } else {
          h.target.emit('close')
        }
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: true
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, terminalWindowSeed())
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_source_lost' })
    expect(importAttempts).toBe(2)
    expect(h.handoff).toHaveBeenCalledTimes(1)
    expect(h.target.show).not.toHaveBeenCalled()
    expect(h.target.destroy).toHaveBeenCalledOnce()
    expect(h.sessions.retire).toHaveBeenCalledWith(h.target.id, 'empty-close')
    expect(h.records.has(h.target.id)).toBe(false)
  })

  it('builds isolated created-target authority after two failed renderer imports', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    configureCreatedTarget(h)
    const transferSeed = terminalWindowSeed()
    transferSeed.group = {
      ...transferSeed.group,
      tabOrder: ['tab-1', 'tab-2'],
      recentTabIds: ['tab-2', 'tab-1']
    }
    const source = terminalWindowSession(true)
    source.tabGroups!['wt-1']![0] = structuredClone(transferSeed.group)
    source.tabsByWorktree['wt-1']!.push({
      ...transferSeed.tab,
      id: 'tab-2',
      ptyId: 'pty-2',
      title: 'Other terminal'
    })
    source.unifiedTabs!['wt-1']!.push({
      ...source.unifiedTabs!['wt-1']![0]!,
      id: 'tab-2',
      entityId: 'tab-2',
      label: 'Other terminal'
    })
    h.records.set(h.source.id, source)
    let importAttempts = 0
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        return () => h.owners.removeRenderer(h.target.webContents as never)
      },
      loadWindow: () => {
        h.owners.markDispatcherReady(h.target.webContents as never)
        coordinator.getContext(ipcEvent(h.target.webContents) as never)
      }
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import' && ++importAttempts === 1) {
        h.source.emit('close')
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: false,
          error: 'target_import_boom'
        })
      )
    })

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, transferSeed)
    ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
    const target = h.records.get(h.target.id)!
    expect(importAttempts).toBe(2)
    expect(target).toMatchObject({
      activeRepoId: transferSeed.repo.id,
      activeWorkspaceKey: transferSeed.canonicalWorkspaceKey,
      activeWorkspaceExecutionHostId: transferSeed.hostId,
      activeWorktreeId: transferSeed.worktreeId,
      activeTabId: transferSeed.tabId,
      activeTabIdByWorktree: { 'wt-1': transferSeed.tabId },
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      activeGroupIdByWorktree: { 'wt-1': transferSeed.group.id }
    })
    expect(target.tabsByWorktree['wt-1']?.map(({ id }) => id)).toEqual(['tab-1'])
    expect(target.tabGroups?.['wt-1']?.[0]?.tabOrder).toEqual(['tab-1'])
    expect(target.unifiedTabs?.['wt-1']?.[0]).toMatchObject({
      id: 'tab-1',
      entityId: 'tab-1',
      groupId: transferSeed.group.id
    })
    expect(h.target.show).toHaveBeenCalledOnce()
  })

  it('imports into the existing target active group without changing its selection', async () => {
    const h = createTerminalWindowTransferHarness()
    const target = terminalWindowSession(false)
    target.activeRepoId = 'target-repo'
    target.activeWorktreeId = 'wt-1'
    target.activeTabId = 'tab-other'
    target.activeTabIdByWorktree = { 'wt-1': 'tab-other' }
    target.activeTabTypeByWorktree = { 'wt-1': 'editor' }
    target.activeGroupIdByWorktree = { 'wt-1': 'target-group' }
    target.tabGroups = {
      'wt-1': [
        {
          id: 'target-group',
          worktreeId: 'wt-1',
          activeTabId: 'tab-other',
          tabOrder: ['tab-other'],
          recentTabIds: ['tab-other']
        }
      ]
    }
    target.tabGroupLayouts = { 'wt-1': { type: 'leaf', groupId: 'target-group' } }
    target.tabsByWorktree['wt-1'] = [
      { ...terminalWindowSeed().tab, id: 'tab-other', ptyId: 'pty-other' }
    ]
    target.unifiedTabs = {
      'wt-1': [
        {
          ...terminalWindowSession(true).unifiedTabs!['wt-1']![0]!,
          id: 'tab-other',
          entityId: 'tab-other',
          groupId: 'target-group'
        }
      ]
    }
    h.records.set(h.target.id, target)
    let importAttempts = 0
    const coordinator = await createCoordinator(h, { createSecondaryWindow: vi.fn() })
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import' && ++importAttempts === 1) {
        h.source.emit('close')
      }
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
    const recovered = h.records.get(h.target.id)!
    expect(recovered).toMatchObject({
      activeRepoId: 'target-repo',
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-other',
      activeTabIdByWorktree: { 'wt-1': 'tab-other' },
      activeTabTypeByWorktree: { 'wt-1': 'editor' },
      activeGroupIdByWorktree: { 'wt-1': 'target-group' }
    })
    expect(recovered.tabGroups?.['wt-1']?.[0]).toMatchObject({
      id: 'target-group',
      activeTabId: 'tab-other',
      tabOrder: ['tab-other', 'tab-1']
    })
    expect(recovered.unifiedTabs?.['wt-1']?.find(({ id }) => id === 'tab-1')?.groupId).toBe(
      'target-group'
    )
  })

  it('reveals but does not commit when source-loss target fallback persistence fails', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    configureCreatedTarget(h)
    const originalSet = h.sessions.set.getMockImplementation()!
    let setCount = 0
    h.sessions.set.mockImplementation((...args) => {
      if (++setCount === 2) {
        throw new Error('target_recovery_persist_boom')
      }
      originalSet(...args)
    })
    let importAttempts = 0
    const coordinator = await createCoordinator(h, {
      registerRenderer: () => {
        h.owners.registerRenderer(h.target.webContents as never)
        return () => h.owners.removeRenderer(h.target.webContents as never)
      },
      loadWindow: () => {
        h.owners.markDispatcherReady(h.target.webContents as never)
        coordinator.getContext(ipcEvent(h.target.webContents) as never)
      }
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import' && ++importAttempts === 1) {
        h.source.emit('close')
      }
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
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target_recovery_failed' })
    expect(h.records.get(h.source.id)?.tabsByWorktree['wt-1']?.[0]).toEqual(
      terminalWindowSeed().tab
    )
    expect(h.owners.owns('pty-1', h.target.webContents as never)).toBe(true)
    expect(h.target.show).toHaveBeenCalledOnce()
    expect(h.target.destroy).not.toHaveBeenCalled()
    expect(h.sessions.retire).not.toHaveBeenCalled()
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
