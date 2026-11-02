import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { publishHeadlessRuntimeGraph } from './headless-runtime-graph'

// A parked paired pane closes its stream, the PTY's last viewer. On a windowless host the PTY must
// keep that viewer's grid, while other viewers and phones can still take it (#15997).

const PTY = 'pty-1'
const SPAWN_GRID = { cols: 120, rows: 40 }

function createRuntime({ headless }: { headless: boolean }) {
  const store = {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces', mobileAutoRestoreFitMs: 5_000 })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub covers the settings and repo reads the viewer floor reaches; the rest of Store is unreached.
  const runtime = new OrcaRuntimeService(store as never)
  const sizes = new Map([[PTY, { ...SPAWN_GRID }]])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resize and getSize are the only controller members the layout queue drives here.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId: string, cols: number, rows: number) => {
      sizes.set(ptyId, { cols, rows })
      return true
    },
    getSize: (ptyId: string) => sizes.get(ptyId) ?? null
  } as never)
  if (headless) {
    publishHeadlessRuntimeGraph(runtime)
  } else {
    runtime.attachWindow(1)
  }
  return { runtime, size: () => sizes.get(PTY) }
}

describe('remote desktop viewers on a parked terminal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the parked owner grid on a windowless host', async () => {
    const { runtime, size } = createRuntime({ headless: true })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)

    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')

    expect(size()).toEqual({ cols: 99, rows: 67 })
  })

  it('lets a phone attaching after the park take the grid', async () => {
    const { runtime, size } = createRuntime({ headless: true })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)
    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')

    await runtime.handleMobileSubscribe(PTY, 'phone', { cols: 45, rows: 20 })

    expect(runtime.getDriver(PTY)).toEqual({ kind: 'mobile', clientId: 'phone' })
    expect(size()).toEqual({ cols: 45, rows: 20 })
  })

  it('returns to the parked grid, not the spawn grid, after that phone leaves', async () => {
    const { runtime, size } = createRuntime({ headless: true })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)
    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')
    await runtime.handleMobileSubscribe(PTY, 'phone', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe(PTY, 'phone')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(runtime.getDriver(PTY).kind).not.toBe('mobile')
    expect(size()).toEqual({ cols: 99, rows: 67 })
  })

  it('restores the parked desktop grid when the park happened while a phone was fitting', async () => {
    const { runtime, size } = createRuntime({ headless: true })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)
    await runtime.handleMobileSubscribe(PTY, 'phone', { cols: 45, rows: 20 })
    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')

    runtime.handleMobileUnsubscribe(PTY, 'phone')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(runtime.getDriver(PTY).kind).not.toBe('mobile')
    expect(size()).toEqual({ cols: 99, rows: 67 })
  })

  it('lets a different desktop viewer that claims after the park take the grid', async () => {
    const { runtime, size } = createRuntime({ headless: true })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)
    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')

    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:b:1', 'mini', 80, 30, false)
    expect(size()).toEqual({ cols: 99, rows: 67 })
    await runtime.claimRemoteDesktopViewer(PTY, 'multiplex:b:1')

    expect(size()).toEqual({ cols: 80, rows: 30 })
  })

  it('still gives a host with a window its grid back', async () => {
    const { runtime, size } = createRuntime({ headless: false })
    await runtime.updateRemoteDesktopViewer(PTY, 'multiplex:a:1', 'laptop', 99, 67)

    await runtime.unregisterRemoteDesktopViewer(PTY, 'multiplex:a:1')

    expect(size()).toEqual(SPAWN_GRID)
  })
})
