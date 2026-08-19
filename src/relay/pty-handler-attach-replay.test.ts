import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as ptyShellUtils from './pty-shell-utils'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import { PtyHandler, attachIdentityMismatches } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty, attachPty } = createPtyRequestHelpers(() => dispatcher)

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('reports not-found and reaps a reattach whose backing shell is dead', async () => {
    // Why: a lingering managed entry whose child died without an onExit would
    // otherwise attach-succeed with an empty replay and strand the pane on a
    // black shell. A provably-dead pid must surface as not-found so the SSH
    // provider maps it to SSH_SESSION_EXPIRED and the pane respawns fresh.
    let onExitCb: ((evt: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => void) => {
        onExitCb = cb
      })
    })
    const exits: { id: string; paneKey?: string }[] = []
    handler.setExitListener((evt) => exits.push(evt))

    await dispatcher.callRequest('pty.spawn', { env: { ORCA_PANE_KEY: 'tab-dead:0' } })
    expect(handler.activePtyCount).toBe(1)
    expect(onExitCb).toBeDefined()

    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(false)
    try {
      await expect(
        dispatcher.callRequest('pty.attach', { id: 'pty-1', suppressReplayNotification: true })
      ).rejects.toThrow('PTY "pty-1" not found')
    } finally {
      aliveSpy.mockRestore()
    }

    // The stale entry is reaped: cache-eviction observers fire and the map slot
    // is freed so a later attach also cleanly reports not-found.
    expect(exits).toEqual([{ id: 'pty-1', paneKey: 'tab-dead:0' }])
    expect(handler.activePtyCount).toBe(0)
    await expect(
      dispatcher.callRequest('pty.attach', { id: 'pty-1', suppressReplayNotification: true })
    ).rejects.toThrow('PTY "pty-1" not found')
  })

  it('settles concurrent immediate shutdown when attach proves the shell exited', async () => {
    const mockKill = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      kill: mockKill,
      onData: vi.fn(),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {})

    let shutdown: Promise<unknown> | undefined
    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockImplementation(() => {
      shutdown = dispatcher.callRequest('pty.shutdown', { id: 'pty-1', immediate: true })
      return false
    })
    try {
      await expect(dispatcher.callRequest('pty.attach', { id: 'pty-1' })).rejects.toThrow(
        'PTY "pty-1" not found'
      )
      await expect(shutdown).resolves.toBeUndefined()
    } finally {
      aliveSpy.mockRestore()
    }

    expect(mockKill).toHaveBeenCalledWith('SIGKILL')
    expect(handler.activePtyCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replays for a reattach whose backing shell is still alive', async () => {
    // Guard the other direction: a live pid must never be reaped, so a quiet
    // but live session still returns its buffered replay on reattach.
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })
    const spawn = await spawnPty()
    dataCallback?.('prompt$ ')

    const aliveSpy = vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
    try {
      const result = await attachPty({
        id: 'pty-1',
        suppressReplayNotification: true
      })
      expect(result).toEqual({ incarnationId: spawn.incarnationId, replay: 'prompt$ ' })
    } finally {
      aliveSpy.mockRestore()
    }
    expect(handler.activePtyCount).toBe(1)
  })

  it('returns attach replay instead of notifying when replay notification is suppressed', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    const spawn = await spawnPty()
    dataCallback!('buffered output')

    const result = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })

    expect(result).toEqual({ incarnationId: spawn.incarnationId, replay: 'buffered output' })
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.replay', expect.anything())
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })

  it('suppresses legacy replay after the V1 owner is already active', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })
    const spawn = await spawnPty()
    dataCallback!('buffered output')
    handler.setSourcePublication({
      activate: vi.fn(() => 'existing'),
      accepts: vi.fn(() => true),
      publish: vi.fn(() => true),
      dispose: vi.fn()
    } as never)

    const result = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })

    expect(result).toEqual({ incarnationId: spawn.incarnationId })
  })

  it('requires restore when the V1 pending-send recovery fence expires', async () => {
    const spawn = await spawnPty()
    const waitForPendingSend = vi.fn().mockResolvedValue(false)
    const activate = vi
      .fn()
      .mockReturnValue({ status: 'restoreRequired', reason: 'checkpointUnavailable' })
    handler.setSourcePublication({
      activate,
      accepts: vi.fn(() => true),
      waitForPendingSend,
      dispose: vi.fn()
    } as never)

    const result = await dispatcher.callRequest(
      'pty.attach',
      {
        id: spawn.id,
        sourceRecovery: {
          status: 'checkpoint',
          deliveryToken: 'old-token',
          ptyIncarnation: spawn.incarnationId,
          clientGeneration: 1,
          ownerGeneration: 1,
          acceptedSourceEndSu: 0
        }
      },
      {
        clientId: 2,
        isStale: () => false,
        onResponseSettled: vi.fn()
      } as never
    )

    expect(waitForPendingSend).toHaveBeenCalledWith(spawn.id)
    expect(activate).toHaveBeenCalledWith(
      spawn.id,
      spawn.incarnationId,
      expect.anything(),
      Object.freeze({ status: 'checkpointUnavailable' })
    )
    expect(result).toEqual({
      incarnationId: spawn.incarnationId,
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
    })
  })

  it('notifies replay on normal attach', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    const spawn = await spawnPty()
    dataCallback!('buffered output')
    dispatcher.notify.mockClear()

    const result = await attachPty({ id: 'pty-1' })

    expect(result).toEqual({ incarnationId: spawn.incarnationId })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.replay', {
      id: 'pty-1',
      data: 'buffered output'
    })
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
  })

  it('uses attach identity metadata without exporting it to the shell env', async () => {
    const oldPaneKey = process.env.ORCA_PANE_KEY
    const oldTabId = process.env.ORCA_TAB_ID
    delete process.env.ORCA_PANE_KEY
    delete process.env.ORCA_TAB_ID
    let spawn!: { id: string; incarnationId: string }
    try {
      spawn = await spawnPty({
        env: { FOO: 'bar' },
        paneKey: 'tab-a:leaf-a',
        tabId: 'tab-a'
      })
    } finally {
      if (oldPaneKey === undefined) {
        delete process.env.ORCA_PANE_KEY
      } else {
        process.env.ORCA_PANE_KEY = oldPaneKey
      }
      if (oldTabId === undefined) {
        delete process.env.ORCA_TAB_ID
      } else {
        process.env.ORCA_TAB_ID = oldTabId
      }
    }

    const spawnOptions = mockPtySpawn.mock.calls[0][2] as { env: Record<string, string> }
    expect(spawnOptions.env.ORCA_PANE_KEY).toBeUndefined()
    expect(spawnOptions.env.ORCA_TAB_ID).toBeUndefined()

    await expect(
      attachPty({
        id: 'pty-1',
        expectedPaneKey: 'tab-b:leaf-b',
        expectedTabId: 'tab-b'
      })
    ).rejects.toThrow('PTY "pty-1" not found')

    await expect(
      attachPty({
        id: 'pty-1',
        expectedPaneKey: 'tab-a:leaf-a',
        expectedTabId: 'tab-a'
      })
    ).resolves.toEqual({ incarnationId: spawn.incarnationId })
  })

  it('notifies on PTY exit and removes from map', async () => {
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCallback = cb
      })
    })

    const spawn = await spawnPty()
    expect(handler.activePtyCount).toBe(1)

    exitCallback!({ exitCode: 0 })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.exit', {
      id: 'pty-1',
      code: 0,
      incarnationId: spawn.incarnationId
    })
    expect(handler.activePtyCount).toBe(0)
  })

  it('retains PTY exit until the ordinary writer admits it', async () => {
    await handler.dispose({ waitForPhysicalExit: false })
    let capacityListener: (() => void) | undefined
    const tryNotifyPtyExit = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    Object.assign(dispatcher, {
      onLegacyPtyCapacity: vi.fn((listener: () => void) => {
        capacityListener = listener
        return vi.fn()
      }),
      tryNotifyPtyData: vi.fn(() => true),
      tryNotifyPtyExit,
      legacyRetentionBelowLowWater: true
    })
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn(),
      onExit: vi.fn((callback: (info: { exitCode: number }) => void) => {
        exitCallback = callback
      })
    })

    const spawn = await spawnPty()
    exitCallback?.({ exitCode: 0 })
    expect(tryNotifyPtyExit).toHaveBeenCalledOnce()

    capacityListener?.()
    expect(tryNotifyPtyExit).toHaveBeenLastCalledWith({
      id: 'pty-1',
      code: 0,
      incarnationId: spawn.incarnationId
    })
    expect(tryNotifyPtyExit).toHaveBeenCalledTimes(2)
  })

  it('flushes pending PTY output before notifying exit', async () => {
    let dataCallback: ((data: string) => void) | undefined
    let exitCallback: ((info: { exitCode: number }) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn((cb: (info: { exitCode: number }) => void) => {
        exitCallback = cb
      })
    })

    const spawn = await spawnPty()
    dataCallback!('final output')
    exitCallback!({ exitCode: 0 })

    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: 'final output'
    })
    expect(dispatcher.notify).toHaveBeenNthCalledWith(2, 'pty.exit', {
      id: 'pty-1',
      code: 0,
      incarnationId: spawn.incarnationId
    })
  })

  it('throws for attach on nonexistent PTY', async () => {
    await expect(dispatcher.callRequest('pty.attach', { id: 'pty-999' })).rejects.toThrow(
      'PTY "pty-999" not found'
    )
  })

  it('attach preserves buffer so repeated attaches return the same data plus new output', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    const spawn = await spawnPty()
    dataCallback!('initial output')

    const r1 = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(r1).toEqual({ incarnationId: spawn.incarnationId, replay: 'initial output' })

    dataCallback!(' more')

    const r2 = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(r2).toEqual({ incarnationId: spawn.incarnationId, replay: 'initial output more' })
  })

  it('second app restart still replays full buffer', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    const spawn = await spawnPty()

    dataCallback!('$ while true; do date; done\r\n')
    dataCallback!('Mon Apr 28\r\n')

    const firstAttach = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(firstAttach.incarnationId).toBe(spawn.incarnationId)

    dataCallback!('Tue Apr 29\r\n')

    const secondAttach = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(secondAttach.incarnationId).toBe(spawn.incarnationId)

    dataCallback!('Wed Apr 30\r\n')

    const result = await attachPty({
      id: 'pty-1',
      suppressReplayNotification: true
    })
    expect(result).toEqual({
      incarnationId: spawn.incarnationId,
      replay: '$ while true; do date; done\r\nMon Apr 28\r\nTue Apr 29\r\nWed Apr 30\r\n'
    })
  })
})

describe('attachIdentityMismatches', () => {
  it('rejects a paneKey collision across relay generations', () => {
    // Old lease expects tab-a's pane; the reset relay's pty-1 belongs to tab-b.
    expect(
      attachIdentityMismatches({ paneKey: 'tab-a:0' }, { paneKey: 'tab-b:0', tabId: 'tab-b' })
    ).toBe(true)
  })

  it('rejects a tabId collision when only tab identity is known', () => {
    expect(attachIdentityMismatches({ tabId: 'tab-a' }, { tabId: 'tab-b' })).toBe(true)
  })

  it('accepts a matching identity', () => {
    expect(
      attachIdentityMismatches(
        { paneKey: 'tab-a:0', tabId: 'tab-a' },
        { paneKey: 'tab-a:0', tabId: 'tab-a' }
      )
    ).toBe(false)
  })

  it('stays permissive when the caller supplies no identity', () => {
    expect(attachIdentityMismatches({}, { paneKey: 'tab-a:0', tabId: 'tab-a' })).toBe(false)
  })

  it('stays permissive when the managed PTY predates identity capture', () => {
    expect(attachIdentityMismatches({ paneKey: 'tab-a:0', tabId: 'tab-a' }, {})).toBe(false)
  })

  it('does not reject on tabId when paneKey matches (split panes share a tab)', () => {
    expect(
      attachIdentityMismatches({ paneKey: 'tab-a:1' }, { paneKey: 'tab-a:1', tabId: 'tab-a' })
    ).toBe(false)
  })
})
