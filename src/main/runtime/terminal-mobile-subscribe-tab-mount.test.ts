/** STA-1840 regression: known blank-terminal handles request a bounded renderer mount. */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type HandleSeed = {
  handle: string
  worktreeId: string
  tabId: string
  ptyId: string | null
}

type RuntimeInternals = {
  handles: Map<
    string,
    HandleSeed & {
      runtimeId: string
      rendererGraphEpoch: number
      leafId: string
      ptyGeneration: number
    }
  >
  getAuthoritativeWindow: () => {
    webContents: { send: (channel: string, payload: unknown) => void }
  }
  leaves: Map<string, unknown>
  issueHandle: (leaf: unknown) => string
}

function seedRuntime(seeds: HandleSeed[]): {
  runtime: OrcaRuntimeService
  send: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as RuntimeInternals
  for (const seed of seeds) {
    internals.handles.set(seed.handle, {
      ...seed,
      runtimeId: 'rt-test',
      rendererGraphEpoch: 1,
      leafId: 'leaf-1',
      ptyGeneration: 1
    })
  }
  const send = vi.fn()
  internals.getAuthoritativeWindow = () => ({ webContents: { send } })
  return { runtime, send }
}

describe('mobile terminal subscribe tab mount', () => {
  it('keeps a waiting real-tab handle usable when the mount binds its first PTY', async () => {
    const runtime = new OrcaRuntimeService()
    const syncGraph = (ptyId: string | null): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            title: 'Terminal',
            activeLeafId: 'leaf-1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            leafId: 'leaf-1',
            paneRuntimeId: 1,
            ptyId
          }
        ]
      })
    }

    runtime.attachWindow(1)
    syncGraph(null)
    const internals = runtime as unknown as RuntimeInternals
    const leaf = internals.leaves.values().next().value
    if (!leaf) {
      throw new Error('expected terminal leaf')
    }
    const handle = internals.issueHandle(leaf)
    const ptyWait = runtime.waitForLeafPtyId(handle)

    syncGraph('pty-1')

    await expect(ptyWait).resolves.toBe('pty-1')
    expect(runtime.resolveLiveLeafForHandle(handle)).toEqual({ ptyId: 'pty-1' })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({ handle })
  })

  it('requests a tab mount by tabId for a real-tab handle awaiting its PTY (null-leaf blank path)', () => {
    const { runtime, send } = seedRuntime([
      { handle: 'h1', worktreeId: 'wt-1', tabId: 'tab-1', ptyId: null }
    ])

    runtime.requestRendererTerminalTabMount('h1')

    expect(send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: 'wt-1',
      tabId: 'tab-1'
    })
  })

  it('requests a tab mount by tabId even when a real-tab handle carries a ptyId', () => {
    const { runtime, send } = seedRuntime([
      { handle: 'h1', worktreeId: 'wt-1', tabId: 'tab-1', ptyId: 'wt-1@@abc' }
    ])

    runtime.requestRendererTerminalTabMount('h1')

    expect(send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      ptyId: 'wt-1@@abc'
    })
  })

  it('requests a mount by ptyId for a synthetic pty-form handle (never-mounted workspace)', () => {
    // Why: never-mounted workspaces expose only synthetic pty handles to mobile.
    const { runtime, send } = seedRuntime([
      { handle: 'h1', worktreeId: 'wt-1', tabId: 'pty:wt-1@@abc', ptyId: 'wt-1@@abc' }
    ])

    runtime.requestRendererTerminalTabMount('h1')

    expect(send).toHaveBeenCalledWith('terminal:requestTabMount', {
      worktreeId: 'wt-1',
      ptyId: 'wt-1@@abc'
    })
  })

  it('does not request a mount when a pty-form handle has no ptyId', () => {
    const { runtime, send } = seedRuntime([
      { handle: 'h1', worktreeId: 'wt-1', tabId: 'pty:abc', ptyId: null }
    ])

    runtime.requestRendererTerminalTabMount('h1')

    expect(send).not.toHaveBeenCalled()
  })

  it('does not request a mount for an unknown handle', () => {
    const { runtime, send } = seedRuntime([])

    runtime.requestRendererTerminalTabMount('missing')

    expect(send).not.toHaveBeenCalled()
  })

  it('swallows window lookup failures so subscribe keeps its fallback', () => {
    const { runtime } = seedRuntime([
      { handle: 'h1', worktreeId: 'wt-1', tabId: 'tab-1', ptyId: null }
    ])
    const internals = runtime as unknown as RuntimeInternals
    internals.getAuthoritativeWindow = () => {
      throw new Error('no window')
    }

    expect(() => runtime.requestRendererTerminalTabMount('h1')).not.toThrow()
  })
})
