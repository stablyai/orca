import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TerminalWindowTransferCoordinatorOptions } from './terminal-window-transfer-coordinator-options'
import {
  createTerminalWindowTransferHarness,
  ipcEvent,
  terminalWindowSeed,
  terminalWindowSession,
  type TerminalWindowTransferHarness
} from './terminal-window-transfer-test-fixture'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn(), getDisplayNearestPoint: vi.fn() }
}))

vi.mock('./pty', () => ({
  handoffPtyRendererOwnership: vi.fn(),
  registerPtyRenderer: vi.fn(),
  sendToPtyOwner: vi.fn()
}))

vi.mock('../window/createMainWindow', () => ({ loadMainWindow: vi.fn() }))

type PartitionRecords = Map<number, Map<ExecutionHostId, WorkspaceSessionState>>

function clone<T>(value: T): T {
  return structuredClone(value)
}

function sshSeed(targetId: string): TerminalWindowTransferSeed {
  const seed = terminalWindowSeed()
  const ptyId = toAppSshPtyId(targetId, 'pty-1')
  seed.hostId = `ssh:${targetId}`
  seed.repo = { ...seed.repo, connectionId: targetId, executionHostId: seed.hostId }
  seed.tab = { ...seed.tab, ptyId }
  seed.layout = { ...seed.layout, ptyIdsByLeafId: { 'leaf-1': ptyId } }
  seed.ptyIds = [ptyId]
  return seed
}

function sessionForSeed(seed: TerminalWindowTransferSeed, withTab: boolean): WorkspaceSessionState {
  const state = terminalWindowSession(withTab)
  state.activeWorkspaceExecutionHostId = seed.hostId
  if (withTab) {
    state.tabsByWorktree[seed.worktreeId] = [clone(seed.tab)]
    state.terminalLayoutsByTabId[seed.tabId] = clone(seed.layout)
    state.tabGroups![seed.worktreeId] = [clone(seed.group)]
    state.remoteSessionIdsByTabId = { [seed.tabId]: seed.ptyIds[0]! }
  }
  return state
}

function bindingOnly(seed: TerminalWindowTransferSeed): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: { [seed.tabId]: clone(seed.layout) },
    remoteSessionIdsByTabId: { [seed.tabId]: seed.ptyIds[0]! }
  }
}

function partitionedSessions(records: PartitionRecords) {
  const getPartition = (windowId: number, hostId: ExecutionHostId = 'local') =>
    records.get(windowId)?.get(hostId) ?? getDefaultWorkspaceSession()
  return {
    get: vi.fn((windowId: number, hostId?: ExecutionHostId) =>
      clone(getPartition(windowId, hostId))
    ),
    set: vi.fn((windowId: number, state: WorkspaceSessionState, hostId?: ExecutionHostId) => {
      const resolved = hostId ?? 'local'
      const byHost = records.get(windowId) ?? new Map()
      byHost.set(resolved, clone(state))
      records.set(windowId, byHost)
    }),
    seedWindow: vi.fn((windowId: number, sessions: ReadonlyMap<string, WorkspaceSessionState>) => {
      records.set(
        windowId,
        new Map([...sessions].map(([hostId, state]) => [hostId as ExecutionHostId, clone(state)]))
      )
    }),
    isWindowEmptyAcrossHosts: vi.fn(() => false),
    retire: vi.fn()
  }
}

async function coordinatorFor(
  h: TerminalWindowTransferHarness,
  sessions: ReturnType<typeof partitionedSessions>,
  overrides: Partial<TerminalWindowTransferCoordinatorOptions> = {}
) {
  const { TerminalWindowTransferCoordinator } = await import('./terminal-window-transfer')
  return new TerminalWindowTransferCoordinator({
    store: {} as never,
    createSecondaryWindow: vi.fn(),
    windows: h.windows,
    sessions: sessions as never,
    owners: h.owners,
    getCursorPoint: () => ({ x: 700, y: 100 }),
    handoff: h.handoff,
    timeoutMs: 100,
    ...overrides
  })
}

function acknowledgeCommands(
  coordinator: Awaited<ReturnType<typeof coordinatorFor>>,
  h: TerminalWindowTransferHarness,
  targetOk = true
): void {
  h.target.webContents.send.mockImplementation((_channel, command) => {
    queueMicrotask(() =>
      coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
        ...command,
        ok: targetOk,
        ...(targetOk ? {} : { error: 'target_import_rejected' })
      })
    )
  })
  h.source.webContents.send.mockImplementation((_channel, command) => {
    queueMicrotask(() =>
      coordinator.acknowledge(ipcEvent(h.source.webContents) as never, { ...command, ok: true })
    )
  })
  coordinator.getContext(ipcEvent(h.target.webContents) as never)
}

describe('terminal window transfer session partition', () => {
  beforeEach(() => vi.clearAllMocks())

  it('moves direct SSH ownership using the complete local session and leaves binding partition unchanged', async () => {
    const h = createTerminalWindowTransferHarness()
    const seed = sshSeed('box-a')
    h.owners.claim(seed.ptyIds[0]!, h.source.webContents as never)
    const sourceBinding = bindingOnly(seed)
    const targetBinding = bindingOnly(seed)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(seed, true)], [seed.hostId, sourceBinding]])],
      [h.target.id, new Map([['local', sessionForSeed(seed, false)], [seed.hostId, targetBinding]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)
    acknowledgeCommands(coordinator, h)

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: true,
      targetWindowId: h.target.id
    })
    expect(h.owners.owns(seed.ptyIds[0]!, h.target.webContents as never)).toBe(true)
    expect(sessions.set.mock.calls.map((call) => call[2] ?? 'local')).toEqual(['local'])
    expect(records.get(h.source.id)?.get(seed.hostId)).toEqual(sourceBinding)
    expect(records.get(h.target.id)?.get(seed.hostId)).toEqual(targetBinding)
  })

  it('seeds a new direct SSH window with only the local session partition', async () => {
    const h = createTerminalWindowTransferHarness({ createTarget: true })
    const seed = sshSeed('box-a')
    h.owners.claim(seed.ptyIds[0]!, h.source.webContents as never)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(seed, true)], [seed.hostId, bindingOnly(seed)]])]
    ])
    const sessions = partitionedSessions(records)
    let coordinator!: Awaited<ReturnType<typeof coordinatorFor>>
    coordinator = await coordinatorFor(h, sessions, {
      createSecondaryWindow: () => {
        h.windows.register(h.target as never, 'secondary')
        return h.target as never
      },
      getWorkArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      registerRenderer: () => () => {},
      loadWindow: () => coordinator.getContext(ipcEvent(h.target.webContents) as never)
    })
    h.target.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, { ...command, ok: true })
      )
    })
    h.source.webContents.send.mockImplementation((_channel, command) => {
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.source.webContents) as never, { ...command, ok: true })
      )
    })

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: true,
      targetWindowId: h.target.id
    })
    const seeded = sessions.seedWindow.mock.calls[0]?.[1] as ReadonlyMap<string, WorkspaceSessionState>
    expect([...seeded.keys()]).toEqual(['local'])
    expect(records.get(h.target.id)?.has(seed.hostId)).toBe(false)
  })

  it('rolls back direct SSH state in local and does not mutate either SSH connection partition', async () => {
    const h = createTerminalWindowTransferHarness()
    const seed = sshSeed('box-a')
    const otherSeed = sshSeed('box-b')
    h.owners.claim(seed.ptyIds[0]!, h.source.webContents as never)
    const sourceBinding = sessionForSeed(seed, true)
    const targetBinding = sessionForSeed(seed, false)
    const unrelatedBinding = bindingOnly(otherSeed)
    const records: PartitionRecords = new Map([
      [
        h.source.id,
        new Map([
          ['local', sessionForSeed(seed, true)],
          [seed.hostId, sourceBinding],
          [otherSeed.hostId, unrelatedBinding]
        ])
      ],
      [h.target.id, new Map([['local', sessionForSeed(seed, false)], [seed.hostId, targetBinding]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)
    acknowledgeCommands(coordinator, h, false)

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: false,
      error: 'target_import_rejected'
    })
    expect(new Set(sessions.set.mock.calls.map((call) => call[2] ?? 'local'))).toEqual(
      new Set(['local'])
    )
    expect(records.get(h.source.id)?.get(seed.hostId)).toEqual(sourceBinding)
    expect(records.get(h.source.id)?.get(otherSeed.hostId)).toEqual(unrelatedBinding)
    expect(records.get(h.target.id)?.get(seed.hostId)).toEqual(targetBinding)
    expect(h.owners.owns(seed.ptyIds[0]!, h.source.webContents as never)).toBe(true)
  })

  it('forward-recovers a source loss in local while preserving the SSH binding partition', async () => {
    const h = createTerminalWindowTransferHarness()
    const seed = sshSeed('box-a')
    h.owners.claim(seed.ptyIds[0]!, h.source.webContents as never)
    const sourceBinding = sessionForSeed(seed, true)
    const targetBinding = bindingOnly(seed)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(seed, true)], [seed.hostId, sourceBinding]])],
      [h.target.id, new Map([['local', sessionForSeed(seed, false)], [seed.hostId, targetBinding]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)
    coordinator.getContext(ipcEvent(h.target.webContents) as never)
    let importAttempts = 0
    h.target.webContents.send.mockImplementation((_channel, command) => {
      if (command.phase === 'target-import' && ++importAttempts === 1) {
        h.source.emit('closed')
      }
      queueMicrotask(() =>
        coordinator.acknowledge(ipcEvent(h.target.webContents) as never, {
          ...command,
          ok: false,
          error: 'target_import_rejected'
        })
      )
    })

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: true,
      targetWindowId: h.target.id
    })
    expect(records.get(h.source.id)?.get('local')?.tabsByWorktree[seed.worktreeId] ?? []).toEqual([])
    expect(records.get(h.target.id)?.get('local')?.tabsByWorktree[seed.worktreeId]).toEqual([
      seed.tab
    ])
    expect(records.get(h.target.id)?.get('local')?.remoteSessionIdsByTabId?.[seed.tabId]).toBe(
      seed.ptyIds[0]
    )
    expect(new Set(sessions.set.mock.calls.map((call) => call[2] ?? 'local'))).toEqual(
      new Set(['local'])
    )
    expect(records.get(h.source.id)?.get(seed.hostId)).toEqual(sourceBinding)
    expect(records.get(h.target.id)?.get(seed.hostId)).toEqual(targetBinding)
  })

  it('does not target a colliding workspace owned by another SSH connection', async () => {
    const h = createTerminalWindowTransferHarness()
    const sourceSeed = sshSeed('box-a')
    const targetSeed = sshSeed('box-b')
    h.owners.claim(sourceSeed.ptyIds[0]!, h.source.webContents as never)
    const targetBefore = sessionForSeed(targetSeed, true)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(sourceSeed, true)]])],
      [h.target.id, new Map([['local', targetBefore]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)

    await expect(
      coordinator.detach(ipcEvent(h.source.webContents) as never, sourceSeed)
    ).resolves.toEqual({ ok: false, error: 'terminal_transfer_target_mismatch' })
    expect(records.get(h.target.id)?.get('local')).toEqual(targetBefore)
    expect(h.handoff).not.toHaveBeenCalled()
    expect(h.owners.owns(sourceSeed.ptyIds[0]!, h.source.webContents as never)).toBe(true)
  })

  it('rejects a direct SSH seed whose full PTY id belongs to another connection', async () => {
    const h = createTerminalWindowTransferHarness()
    const seed = sshSeed('box-a')
    const foreignPtyId = toAppSshPtyId('box-b', 'pty-1')
    seed.tab = { ...seed.tab, ptyId: foreignPtyId }
    seed.layout = { ...seed.layout, ptyIdsByLeafId: { 'leaf-1': foreignPtyId } }
    seed.ptyIds = [foreignPtyId]
    h.owners.claim(foreignPtyId, h.source.webContents as never)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(seed, true)]])],
      [h.target.id, new Map([['local', sessionForSeed(seed, false)]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)
    acknowledgeCommands(coordinator, h)

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: false,
      error: 'invalid_terminal_transfer_seed'
    })
    expect(h.handoff).not.toHaveBeenCalled()
    expect(sessions.set).not.toHaveBeenCalled()
  })

  it('rejects a seed whose repo execution authority differs from its host', async () => {
    const h = createTerminalWindowTransferHarness()
    const seed = sshSeed('box-a')
    seed.repo = { ...seed.repo, connectionId: 'box-b', executionHostId: 'ssh:box-b' }
    h.owners.claim(seed.ptyIds[0]!, h.source.webContents as never)
    const records: PartitionRecords = new Map([
      [h.source.id, new Map([['local', sessionForSeed(seed, true)]])],
      [h.target.id, new Map([['local', sessionForSeed(seed, false)]])]
    ])
    const sessions = partitionedSessions(records)
    const coordinator = await coordinatorFor(h, sessions)
    acknowledgeCommands(coordinator, h)

    await expect(coordinator.detach(ipcEvent(h.source.webContents) as never, seed)).resolves.toEqual({
      ok: false,
      error: 'invalid_terminal_transfer_seed'
    })
    expect(h.handoff).not.toHaveBeenCalled()
    expect(sessions.set).not.toHaveBeenCalled()
  })

  it.each(['local', 'runtime:env-a'] as const)(
    'keeps the %s transfer path in its existing persistence partition',
    async (hostId) => {
      const h = createTerminalWindowTransferHarness()
      const seed = terminalWindowSeed()
      seed.hostId = hostId
      seed.repo = { ...seed.repo, executionHostId: hostId }
      const records: PartitionRecords = new Map([
        [h.source.id, new Map([[hostId, sessionForSeed(seed, true)]])],
        [h.target.id, new Map([[hostId, sessionForSeed(seed, false)]])]
      ])
      const sessions = partitionedSessions(records)
      const coordinator = await coordinatorFor(h, sessions)
      acknowledgeCommands(coordinator, h)

      await expect(
        coordinator.detach(ipcEvent(h.source.webContents) as never, seed)
      ).resolves.toEqual({ ok: true, targetWindowId: h.target.id })
      expect(sessions.set.mock.calls.map((call) => call[2] ?? 'local')).toEqual([hostId])
    }
  )
})
