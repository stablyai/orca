import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeAllListenersMock, removeHandlerMock, fromWebContentsMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    onMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    fromWebContentsMock: vi.fn()
  }))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeHandler: removeHandlerMock
  }
}))

import type { WebContents } from 'electron'
import { registerRuntimeHandlers } from './runtime'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../shared/terminal-fit-restore-deadline'
import { PROJECT_SECTION_PARITY_SERVED } from '../../shared/project-section-parity.test-fixture'
import { readMobileProjectSections } from '../runtime/mobile-project-sections-snapshot'
import {
  registerDesktopRenderer,
  unregisterDesktopRenderer
} from '../window/desktop-renderer-registry'
import { registerNativeDesktopNotifier } from '../window/native-desktop-notifiers'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

function stubRuntimeNotifier(): RuntimeNotifier {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

function runtimeCallEvent() {
  const mainFrame = {}
  return {
    sender: {
      id: 1,
      mainFrame,
      on: vi.fn(),
      once: vi.fn()
    },
    senderFrame: mainFrame
  }
}

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    removeHandlerMock.mockReset()
    fromWebContentsMock.mockReset()
  })

  it('routes sync requests through the authoritative browser window id', () => {
    const runtime = {
      syncWindowGraph: vi.fn().mockReturnValue({ graphStatus: 'ready' }),
      getStatus: vi.fn().mockReturnValue({ graphStatus: 'unavailable' }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const syncRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    expect(syncRegistration).toBeTruthy()

    fromWebContentsMock.mockReturnValue({ id: 17 })

    const currentMainFrame = {}
    const sender = { mainFrame: currentMainFrame }
    const handler = syncRegistration![1]
    const graph = { tabs: [], leaves: [], rendererGeneration: 'renderer-1' }
    const result = handler({ sender, senderFrame: currentMainFrame }, graph)

    expect(runtime.syncWindowGraph).toHaveBeenCalledWith(17, graph)
    expect(result).toEqual({ graphStatus: 'ready' })
  })

  it("serves the authoritative window's sidebar catalog to paired phones, and keeps it when omitted", () => {
    const runtime = { syncWindowGraph: vi.fn().mockReturnValue({ graphStatus: 'ready' }) }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const currentMainFrame = {}
    const event = { sender: { mainFrame: currentMainFrame }, senderFrame: currentMainFrame }
    fromWebContentsMock.mockReturnValue({ id: 17 })
    const graph = { tabs: [], leaves: [], rendererGeneration: 'renderer-1' }

    handler(event, { ...graph, projectSectionCatalog: PROJECT_SECTION_PARITY_SERVED })
    handler(event, graph)

    expect(readMobileProjectSections()).toEqual({ catalog: PROJECT_SECTION_PARITY_SERVED })
  })

  it('does not serve a catalog from a graph the runtime refused', () => {
    const refused = { ...PROJECT_SECTION_PARITY_SERVED, projectOrderBy: 'recent' as const }
    const runtime = {
      syncWindowGraph: vi.fn(() => {
        throw new Error('Runtime graph publisher does not match the authoritative window')
      })
    }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const currentMainFrame = {}
    fromWebContentsMock.mockReturnValue({ id: 18 })

    expect(() =>
      handler(
        { sender: { mainFrame: currentMainFrame }, senderFrame: currentMainFrame },
        { tabs: [], leaves: [], rendererGeneration: 'renderer-2', projectSectionCatalog: refused }
      )
    ).toThrow()
    expect(readMobileProjectSections().catalog).not.toEqual(refused)
  })

  it('rejects a graph publication queued by a superseded main frame', () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn()
    }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const sender = { mainFrame: { generation: 2 } }
    fromWebContentsMock.mockReturnValue({ id: 17 })

    expect(() =>
      handler({ sender, senderFrame: { generation: 1 } }, { tabs: [], leaves: [] })
    ).toThrow('Runtime graph sync must originate from the current main frame')
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('rejects graph publications without a renderer generation', () => {
    const runtime = { syncWindowGraph: vi.fn() }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const currentMainFrame = {}
    const sender = { mainFrame: currentMainFrame }
    fromWebContentsMock.mockReturnValue({ id: 17 })

    expect(() =>
      handler({ sender, senderFrame: currentMainFrame }, { tabs: [], leaves: [] })
    ).toThrow('Runtime graph sync requires a renderer generation')
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
  })

  it('flushes a buffered broadcast to a native window once it pings runtime:notifierReady', () => {
    const runtime = { syncWindowGraph: vi.fn(), setNotifier: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only retains this partial runtime; the test invokes the notifier-ready handler.
    registerRuntimeHandlers(runtime as never)
    const readyHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:notifierReady'
    )?.[1]
    expect(readyHandler).toBeTypeOf('function')

    const mainFrame = {}
    const renderer = {
      id: 901,
      on: vi.fn(),
      getType: () => 'window',
      isDestroyed: () => false,
      mainFrame
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the renderer registry and readiness handler members exercised here.
    const webContents = renderer as unknown as WebContents
    const window = { id: 901, isDestroyed: () => false, webContents }
    registerDesktopRenderer(webContents, 'window-901')
    try {
      const reposChanged = vi.fn()
      const notifier: RuntimeNotifier = {
        ...stubRuntimeNotifier(),
        reposChanged,
        worktreesChanged: vi.fn()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing uses only the fixture's setNotifier; no runtime graph command is invoked.
      registerNativeDesktopNotifier(runtime as never, window, notifier, () => true)
      const router = runtime.setNotifier.mock.calls.at(-1)?.[0]
      router.reposChanged()
      expect(reposChanged).not.toHaveBeenCalled()

      fromWebContentsMock.mockReturnValue(window)
      readyHandler?.({ sender: webContents, senderFrame: mainFrame })

      expect(reposChanged).toHaveBeenCalledTimes(1)
    } finally {
      unregisterDesktopRenderer(webContents)
    }
  })

  it('ignores runtime:notifierReady from a sender with no registered desktop window id', () => {
    const runtime = { syncWindowGraph: vi.fn(), setNotifier: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test exercises admission only and invokes no other runtime service method.
    registerRuntimeHandlers(runtime as never)
    const readyHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:notifierReady'
    )?.[1]

    fromWebContentsMock.mockReturnValue({ id: 999 })
    expect(() => readyHandler?.({ sender: { id: 999 } })).not.toThrow()
  })

  it('ignores runtime:notifierReady sent from a stale (non-main) frame', () => {
    const runtime = { syncWindowGraph: vi.fn(), setNotifier: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stale-frame admission test invokes no runtime operations.
    registerRuntimeHandlers(runtime as never)
    const readyHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:notifierReady'
    )?.[1]

    const mainFrame = {}
    const staleFrame = {}
    const renderer = {
      id: 902,
      on: vi.fn(),
      getType: () => 'window',
      isDestroyed: () => false,
      mainFrame
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the registry and sender-frame identity used by admission.
    const webContents = renderer as unknown as WebContents
    const window = { id: 902, isDestroyed: () => false, webContents }
    registerDesktopRenderer(webContents, 'window-902')
    try {
      const reposChanged = vi.fn()
      const notifier: RuntimeNotifier = { ...stubRuntimeNotifier(), reposChanged }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only setNotifier is used, since the rejected sender never issues a graph command.
      registerNativeDesktopNotifier(runtime as never, window, notifier, () => true)
      const router = runtime.setNotifier.mock.calls.at(-1)?.[0]
      router.reposChanged()

      fromWebContentsMock.mockReturnValue(window)
      expect(() => readyHandler?.({ sender: webContents, senderFrame: staleFrame })).not.toThrow()

      expect(reposChanged).not.toHaveBeenCalled()
    } finally {
      unregisterDesktopRenderer(webContents)
    }
  })

  it('answers runtime:getStatus only once the machine-name lookup has landed', async () => {
    let machineName = 'm4-air.local'
    let finishLookup: (() => void) | undefined
    const runtime = {
      machineNameReady: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishLookup = () => {
              machineName = 'Friendly Name'
              resolve()
            }
          })
      ),
      getStatus: vi.fn(() => ({ runtimeId: 'runtime-1', machineName }))
    }

    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(([channel]) => channel === 'runtime:getStatus')![1]
    const pending = handler()
    finishLookup?.()

    await expect(pending).resolves.toMatchObject({ machineName: 'Friendly Name' })
  })

  it('routes generic local runtime RPC calls through the dispatcher', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      machineNameReady: vi.fn(async () => undefined),
      getStatus: vi.fn().mockReturnValue({
        runtimeId: 'runtime-1',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0
      }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    const result = await handler(runtimeCallEvent(), { method: 'status.get' })

    expect(result).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-1', graphStatus: 'ready' },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('projects Claude structured tabs to the same-version desktop client', async () => {
    const claudeTab = {
      type: 'agent-session',
      id: 'agent-session:claude-1',
      title: 'Claude Chat',
      sessionId: 'claude-1',
      agent: 'claude',
      isActive: true
    }
    const runtime = {
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      getClientSettings: vi.fn(() => ({ experimentalNativeChat: true })),
      restoreStructuredAgentSessionTabs: vi.fn(async () => undefined),
      listMobileSessionTabs: vi.fn(async () => ({
        worktree: 'workspace-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: 'group-1',
        activeTabId: claudeTab.id,
        activeTabType: 'agent-session',
        tabGroups: [{ id: 'group-1', activeTabId: claudeTab.id, tabOrder: [claudeTab.id] }],
        tabs: [claudeTab]
      }))
    }

    registerRuntimeHandlers(runtime as never)
    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    const result = await callRegistration![1](runtimeCallEvent(), {
      method: 'session.tabs.list',
      params: { worktree: 'id:workspace-1' }
    })

    expect(result).toMatchObject({ ok: true, result: { tabs: [claudeTab] } })
  })

  it('registers project group runtime RPC methods for local desktop callers', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      listVisibleProjectGroups: vi.fn().mockReturnValue([{ id: 'group-1', name: 'Platform' }])
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    const result = await handler(runtimeCallEvent(), { method: 'projectGroup.list' })

    expect(result).toMatchObject({
      ok: true,
      result: { groups: [{ id: 'group-1', name: 'Platform' }] },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('registers local runtime streaming subscription lifecycle handlers', () => {
    registerRuntimeHandlers({ syncWindowGraph: vi.fn(), getStatus: vi.fn() } as never)

    expect(handleMock.mock.calls.some(([channel]) => channel === 'runtime:subscribe')).toBe(true)
    expect(onMock.mock.calls.some(([channel]) => channel === 'runtime:unsubscribe')).toBe(true)
    expect(removeAllListenersMock).toHaveBeenCalledWith('runtime:unsubscribe')
  })

  it('deduplicates retries while a terminal fit restore is still pending', async () => {
    const finishRestoreByPtyId = new Map<string, (restored: boolean) => void>()
    const reclaimTerminalForDesktop = vi.fn(
      (ptyId: string) =>
        new Promise<boolean>((resolve) => {
          finishRestoreByPtyId.set(ptyId, resolve)
        })
    )
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      reclaimTerminalForDesktop
    }
    registerRuntimeHandlers(runtime as never)
    const restoreRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:restoreTerminalFit'
    )
    expect(restoreRegistration).toBeTruthy()
    const handler = restoreRegistration![1]

    const first = handler({ sender: {} }, { ptyId: 'pty-1' })
    const retry = handler({ sender: {} }, { ptyId: 'pty-1' })
    const otherTerminal = handler({ sender: {} }, { ptyId: 'pty-2' })

    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(2, 'pty-2')
    finishRestoreByPtyId.get('pty-1')?.(true)
    finishRestoreByPtyId.get('pty-2')?.(true)
    await expect(otherTerminal).resolves.toEqual({ restored: true })
    await expect(first).resolves.toEqual({ restored: true })
    await expect(retry).resolves.toEqual({ restored: true })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)

    const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-1' })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(3)
    finishRestoreByPtyId.get('pty-1')?.(false)
    await expect(afterSettlement).resolves.toEqual({ restored: false })
  })

  it('bounds retries without accumulating reclaim waiters for one PTY', async () => {
    vi.useFakeTimers()
    try {
      let finishRestore!: (restored: boolean) => void
      const reclaimTerminalForDesktop = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishRestore = resolve
          })
      )
      registerRuntimeHandlers({
        syncWindowGraph: vi.fn(),
        getStatus: vi.fn(),
        reclaimTerminalForDesktop
      } as never)
      const handler = handleMock.mock.calls.find(
        ([channel]) => channel === 'runtime:restoreTerminalFit'
      )![1]

      const first = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      await vi.advanceTimersByTimeAsync(TERMINAL_FIT_RESTORE_DEADLINE_MS)
      await expect(first).resolves.toEqual({ restored: false })

      const retry = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(1)
      finishRestore(true)
      await expect(retry).resolves.toEqual({ restored: true })

      const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
      finishRestore(false)
      await expect(afterSettlement).resolves.toEqual({ restored: false })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
