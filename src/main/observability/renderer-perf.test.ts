import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcListener = (event: { sender: { id: number } }, args: unknown) => void

const { ipcOnMock, appMetricsMock } = vi.hoisted(() => ({
  ipcOnMock: vi.fn(),
  appMetricsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcOnMock },
  app: { getAppMetrics: appMetricsMock }
}))

import { collectRendererPerfMetrics } from './renderer-perf'

type FakeWebContents = {
  id: number
  isDestroyed: () => boolean
  getOSProcessId: () => number
  send: ReturnType<typeof vi.fn>
  debugger: {
    isAttached: () => boolean
    attach: (version: string) => void
    detach: () => void
    sendCommand: ReturnType<typeof vi.fn>
  }
}

function makeWebContents(overrides: Partial<FakeWebContents> = {}): FakeWebContents {
  let attached = false
  return {
    id: 7,
    isDestroyed: () => false,
    getOSProcessId: () => 4242,
    send: vi.fn(),
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => {
        attached = true
      }),
      detach: vi.fn(() => {
        attached = false
      }),
      sendCommand: vi.fn().mockResolvedValue({ documents: 2, nodes: 1500, jsEventListeners: 320 })
    },
    ...overrides
  }
}

function getResponseListener(): IpcListener {
  const call = ipcOnMock.mock.calls.find(
    ([channel]) => channel === 'diagnostics:rendererPerf:response'
  )
  expect(call).toBeDefined()
  return call![1] as IpcListener
}

function extractRequestId(webContents: FakeWebContents): string {
  const call = webContents.send.mock.calls.find(
    ([channel]) => channel === 'diagnostics:rendererPerf:request'
  )
  expect(call).toBeDefined()
  return (call![1] as { requestId: string }).requestId
}

const minimalRendererMetrics = {
  domNodeCount: 12,
  terminalPanes: {
    totalMountedPaneCount: 1,
    worktrees: [
      {
        worktreeLabel: 'my-secret-project',
        worktreeKind: 'local',
        paneCount: 1,
        scrollbackRowsTotal: 42,
        panes: [{ cols: 80, rows: 24, normalBufferRows: 42, altBufferRows: 0, hasWebgl: false }]
      }
    ]
  },
  browserPanes: { browserWebviewCount: 0, registeredBrowserGuestCount: 0 },
  registries: {
    ptySerializerCount: 0,
    livePaneManagerCount: 0,
    browserWebviewCount: 0,
    registeredBrowserGuestCount: 0
  }
}

describe('collectRendererPerfMetrics', () => {
  beforeEach(() => {
    appMetricsMock.mockReturnValue([{ pid: 4242, memory: { workingSetSize: 2048 } }])
  })

  it('returns an unavailable record when no renderer webContents exists', async () => {
    const record = await collectRendererPerfMetrics(() => null)
    expect(record.type).toBe('renderer-perf')
    expect(record.unavailableReason).toBe('no-renderer')
  })

  it('merges renderer metrics with main-side CDP and process-memory counters', async () => {
    const webContents = makeWebContents()
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 2000 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())
    getResponseListener()(
      { sender: { id: webContents.id } },
      { requestId: extractRequestId(webContents), metrics: minimalRendererMetrics }
    )

    const record = await pending
    expect(record.renderer?.domNodeCount).toBe(12)
    expect(record.main?.domCounters).toEqual({ documents: 2, nodes: 1500, jsEventListeners: 320 })
    // Electron reports MemoryInfo in KiB; the record must be in bytes.
    expect(record.main?.processMemoryBytes?.workingSetSizeBytes).toBe(2048 * 1024)
    expect(record.unavailableReason).toBeUndefined()
    // Default (bundle) records must not carry user-chosen folder names.
    expect(record.renderer?.terminalPanes.worktrees[0]?.worktreeLabel).toBe('worktree-1')
    expect(record.renderer?.terminalPanes.worktrees[0]?.paneCount).toBe(1)
  })

  it('keeps folder-basename labels only in named mode (local perf dump)', async () => {
    const webContents = makeWebContents()
    const pending = collectRendererPerfMetrics(() => webContents as never, {
      timeoutMs: 2000,
      labelMode: 'named'
    })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())
    getResponseListener()(
      { sender: { id: webContents.id } },
      { requestId: extractRequestId(webContents), metrics: minimalRendererMetrics }
    )

    const record = await pending
    expect(record.renderer?.terminalPanes.worktrees[0]?.worktreeLabel).toBe('my-secret-project')
  })

  it('degrades when the CDP command hangs instead of hanging collection', async () => {
    const webContents = makeWebContents()
    webContents.debugger.sendCommand = vi.fn(() => new Promise(() => {}))
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 25 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())

    const record = await pending
    expect(record.main?.domCounters).toBeUndefined()
    expect(record.unavailable?.domCounters).toBe('timeout')
    expect(webContents.debugger.detach).toHaveBeenCalled()
  })

  it('ignores responses from an untrusted sender and degrades to timeout', async () => {
    const webContents = makeWebContents()
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 25 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())
    getResponseListener()(
      { sender: { id: webContents.id + 1 } },
      { requestId: extractRequestId(webContents), metrics: minimalRendererMetrics }
    )

    const record = await pending
    expect(record.renderer).toBeUndefined()
    expect(record.unavailable?.renderer).toBe('timeout')
    // Main-side counters still ride along when only the renderer times out.
    expect(record.main?.domCounters?.nodes).toBe(1500)
  })

  it('degrades to invalid-response when the renderer payload fails narrowing', async () => {
    const webContents = makeWebContents()
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 2000 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())
    getResponseListener()(
      { sender: { id: webContents.id } },
      { requestId: extractRequestId(webContents), metrics: 'not-an-object' }
    )

    const record = await pending
    expect(record.renderer).toBeUndefined()
    expect(record.unavailable?.renderer).toBe('invalid-response')
  })

  it('omits CDP counters when the debugger attach fails and releases nothing it does not own', async () => {
    const webContents = makeWebContents()
    webContents.debugger.attach = vi.fn(() => {
      throw new Error('Another debugger is already attached')
    })
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 25 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())

    const record = await pending
    expect(record.main?.domCounters).toBeUndefined()
    expect(record.unavailable?.domCounters).toContain('debugger')
    expect(webContents.debugger.detach).not.toHaveBeenCalled()
  })

  it('reports process memory as unavailable when the renderer pid is missing from app metrics', async () => {
    appMetricsMock.mockReturnValue([{ pid: 1, memory: { workingSetSize: 10 } }])
    const webContents = makeWebContents()
    const pending = collectRendererPerfMetrics(() => webContents as never, { timeoutMs: 25 })
    await vi.waitFor(() => expect(webContents.send).toHaveBeenCalled())

    const record = await pending
    expect(record.main?.processMemoryBytes).toBeUndefined()
    expect(record.unavailable?.processMemory).toBe('renderer process metric unavailable')
  })
})
