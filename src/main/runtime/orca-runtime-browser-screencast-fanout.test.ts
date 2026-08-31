import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES } from '../../shared/remote-runtime-memory-limits'
import { BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT } from './browser-screencast-ghost-subscriber-eviction'
import type { RuntimeBrowserCommandHost, RuntimeBrowserCommands } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createCommandsHost(): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge = {
    getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
    getActivePageId: vi.fn(() => 'page-1'),
    tabList: vi.fn(() => ({
      tabs: [
        {
          browserPageId: 'page-1',
          index: 0,
          url: 'about:blank',
          title: 'Browser',
          active: true
        }
      ]
    }))
  } as unknown as AgentBrowserBridge
  return {
    resolveWorktreeSelector: async () => ({ id: 'wt-1' }),
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null)
  } as unknown as RuntimeBrowserCommandHost
}

describe('RuntimeBrowserCommands screencast fanout', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  it('restores the surviving subscriber viewport without stopping its shared stream', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    const updateViewport = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({ stop, done: done.promise, updateViewport })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const firstSend = vi.fn(() => false)
    const secondSend = vi.fn(() => true)
    const first = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: firstSend }
    )
    const second = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 800,
        viewportHeight: 600
      },
      { sendBinary: secondSend }
    )

    const frame = new Uint8Array([1, 2, 3])
    expect(startBrowserScreencast).toHaveBeenCalledOnce()
    expect(startBrowserScreencast.mock.calls[0][1].onFrame(frame)).toBe(true)
    expect(firstSend).toHaveBeenCalledWith(frame)
    expect(secondSend).toHaveBeenCalledWith(frame)
    expect(updateViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewportWidth: 800, viewportHeight: 600 })
    )
    second.session.stop()
    await second.session.done
    expect(stop).not.toHaveBeenCalled()
    expect(updateViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewportWidth: 1200, viewportHeight: 800 })
    )
    first.session.stop()
    await first.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps viewport authority with sized subscribers when a sizeless viewer joins', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    const updateViewport = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({ stop, done: done.promise, updateViewport })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const sized = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: vi.fn(() => true) }
    )
    const sizeless = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: vi.fn(() => true) }
    )

    // Why: a sizeless owner would push undefined dimensions into the shared
    // stream and clear the device-metrics override for every viewer.
    expect(updateViewport).not.toHaveBeenCalled()

    sized.session.stop()
    await sized.session.done
    expect(updateViewport).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    sizeless.session.stop()
    await sizeless.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('replays the joiner snapshot that its pre-ready gate refused', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const snapshot = new Uint8Array([9, 9, 9])
    let onFrame: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void = () => true
    // Why: updateViewport exists to capture a frame for the joiner, and it runs while the
    // joiner's ready gate is still closed.
    const updateViewport = vi.fn(async () => {
      onFrame(snapshot)
    })
    startBrowserScreencast.mockImplementation(async (_guest: unknown, options: never) => {
      onFrame = (options as { onFrame: typeof onFrame }).onFrame
      return {
        stop: vi.fn(() => done.resolve()),
        done: done.promise,
        updateViewport,
        updateFrameBudget: vi.fn(async () => {})
      }
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const creatorSend = vi.fn(() => true)
    await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: creatorSend }
    )
    let gateOpen = false
    const joinerSend = vi.fn(() => gateOpen)
    const joiner = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 800,
        viewportHeight: 600
      },
      { sendBinary: joinerSend }
    )

    expect(creatorSend).toHaveBeenCalledWith(snapshot)
    expect(joinerSend).toHaveBeenCalledWith(snapshot)
    joinerSend.mockClear()
    gateOpen = true
    joiner.flushPendingFrame()
    expect(joinerSend).toHaveBeenCalledExactlyOnceWith(snapshot)

    // The accepted replay is not retained, so a second flush cannot duplicate it.
    joinerSend.mockClear()
    joiner.flushPendingFrame()
    expect(joinerSend).not.toHaveBeenCalled()
    joiner.session.stop()
    await joiner.session.done
  })

  it('drives the shared stream at the most constrained subscriber and releases it on leave', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const updateFrameBudget = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({
      stop: vi.fn(() => done.resolve()),
      done: done.promise,
      updateViewport: vi.fn(async () => {}),
      updateFrameBudget
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const desktop = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        quality: 70,
        maxWidth: 3840,
        maxHeight: 2160,
        everyNthFrame: 2
      },
      { sendBinary: vi.fn(() => true) }
    )
    expect(startBrowserScreencast).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxWidth: 3840, everyNthFrame: 2, minFrameIntervalMs: 0 })
    )

    const phone = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        quality: 72,
        maxWidth: 975,
        maxHeight: 844,
        everyNthFrame: 1,
        minFrameIntervalMs: 100
      },
      { sendBinary: vi.fn(() => true) }
    )
    expect(updateFrameBudget).toHaveBeenLastCalledWith({
      quality: 70,
      maxWidth: 975,
      maxHeight: 844,
      everyNthFrame: 1,
      minFrameIntervalMs: 100
    })

    phone.session.stop()
    await phone.session.done
    expect(updateFrameBudget).toHaveBeenLastCalledWith({
      quality: 70,
      maxWidth: 3840,
      maxHeight: 2160,
      everyNthFrame: 2,
      minFrameIntervalMs: 0
    })
    desktop.session.stop()
    await desktop.session.done
  })

  it('admits shared frames through the paired-runtime size guard', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    startBrowserScreencast.mockResolvedValue({
      stop: vi.fn(() => done.resolve()),
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const sendBinary = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const started = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary }
    )
    const { onFrame } = startBrowserScreencast.mock.calls[0][1]

    expect(onFrame(new Uint8Array(REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES + 1))).toBe(true)
    expect(sendBinary).not.toHaveBeenCalled()
    expect(onFrame(new Uint8Array(64))).toBe(true)
    expect(sendBinary).toHaveBeenCalledOnce()
    started.session.stop()
    await started.session.done
  })
})

describe('RuntimeBrowserCommands screencast ghost eviction', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  type Subscription = Awaited<ReturnType<RuntimeBrowserCommands['browserScreencast']>>

  function pumpFrames(count: number): void {
    const onFrame = startBrowserScreencast.mock.calls[0][1].onFrame
    for (let index = 0; index < count; index += 1) {
      onFrame(new Uint8Array([index & 0xff]))
    }
  }

  // A viewer that received frames and then vanished: the E2EE channel refuses permanently once
  // its socket leaves OPEN, which is exactly what a force-quit client leaves behind.
  function sendUntilQuit(framesBeforeQuit: number) {
    let sent = 0
    return vi.fn((_bytes: Uint8Array<ArrayBufferLike>) => sent++ < framesBeforeQuit)
  }

  it('evicts a departed subscriber and hands its viewport to the survivor', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    const updateViewport = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({ stop, done: done.promise, updateViewport })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const survivorSend = vi.fn(() => true)
    const survivor: Subscription = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: survivorSend }
    )
    const ghostSend = sendUntilQuit(1)
    const ghost: Subscription = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 800,
        viewportHeight: 600
      },
      { sendBinary: ghostSend }
    )
    updateViewport.mockClear()

    pumpFrames(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT)
    expect(stop).not.toHaveBeenCalled()
    expect(updateViewport).not.toHaveBeenCalled()

    pumpFrames(1)
    await ghost.session.done
    // Why: eviction has to unwind through the same leave path an explicit stop uses — the ghost
    // owned the viewport, so the survivor's dimensions are restored on the shared stream.
    expect(updateViewport).toHaveBeenCalledWith(
      expect.objectContaining({ viewportWidth: 1200, viewportHeight: 800 })
    )
    expect(stop).not.toHaveBeenCalled()

    const ghostSends = ghostSend.mock.calls.length
    const survivorSends = survivorSend.mock.calls.length
    pumpFrames(10)
    expect(ghostSend).toHaveBeenCalledTimes(ghostSends)
    expect(survivorSend).toHaveBeenCalledTimes(survivorSends + 10)

    survivor.session.stop()
    await survivor.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('stops the shared stream when the evicted subscriber was the last one', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    startBrowserScreencast.mockResolvedValue({
      stop,
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const only: Subscription = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: sendUntilQuit(1) }
    )

    pumpFrames(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT + 1)
    await only.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('keeps a subscriber whose refusals are broken by a delivery', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    startBrowserScreencast.mockResolvedValue({
      stop,
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    let sends = 0
    // Why: this is the backpressure shape — a link that drains one frame per window must never
    // be mistaken for a socket that is gone.
    const backpressured: Subscription = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      {
        sendBinary: vi.fn(() => sends++ % BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT === 0)
      }
    )

    pumpFrames(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT * 5)
    expect(stop).not.toHaveBeenCalled()

    backpressured.session.stop()
    await backpressured.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('never evicts on the refusals a joiner pre-ready gate produced', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    startBrowserScreencast.mockResolvedValue({
      stop,
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    let gateOpen = false
    const joinerSend = vi.fn(() => gateOpen)
    const joiner: Subscription = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: joinerSend }
    )

    // A slow ready gate refuses far past the limit, and none of it is evidence about the viewer.
    pumpFrames(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT * 3)
    expect(stop).not.toHaveBeenCalled()

    gateOpen = true
    joiner.flushPendingFrame()
    gateOpen = false
    // The replay landed, so the eviction clock starts here rather than carrying the gate's streak.
    pumpFrames(BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT - 1)
    expect(stop).not.toHaveBeenCalled()
    pumpFrames(1)
    await joiner.session.done
    expect(stop).toHaveBeenCalledOnce()
  })

  it('replaces the older subscription when the same paired device reattaches', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    const updateViewport = vi.fn(async () => {})
    startBrowserScreencast.mockResolvedValue({ stop, done: done.promise, updateViewport })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const ghostSend = vi.fn(() => true)
    const ghost: Subscription = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: ghostSend, pairedDeviceId: 'device-a' }
    )
    const otherSend = vi.fn(() => true)
    await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: otherSend, pairedDeviceId: 'device-b' }
    )
    const reattachSend = vi.fn(() => true)
    await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 900,
        viewportHeight: 700
      },
      { sendBinary: reattachSend, pairedDeviceId: 'device-a' }
    )

    // Why: the reconnect arrives on a fresh socket, so the connection-keyed replacement upstream
    // cannot see the abandoned subscription — the device identity is what closes it.
    await ghost.session.done
    expect(stop).not.toHaveBeenCalled()

    pumpFrames(1)
    expect(ghostSend).not.toHaveBeenCalled()
    expect(reattachSend).toHaveBeenCalledOnce()
    expect(otherSend).toHaveBeenCalledOnce()
    // The replacement inherits viewport authority rather than leaving it with the evicted stream.
    expect(updateViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewportWidth: 900, viewportHeight: 700 })
    )
  })

  it('leaves other devices and unidentified callers attached', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const done = deferred()
    const stop = vi.fn(() => done.resolve())
    startBrowserScreencast.mockResolvedValue({
      stop,
      done: done.promise,
      updateViewport: vi.fn(async () => {})
    })
    const commands = new RuntimeBrowserCommands(createCommandsHost())
    const anonymousFirst = vi.fn(() => true)
    const anonymousSecond = vi.fn(() => true)
    const identified = vi.fn(() => true)
    await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: anonymousFirst }
    )
    await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: anonymousSecond }
    )
    await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: identified, pairedDeviceId: 'device-a' }
    )

    pumpFrames(1)
    // Why: an absent pairedDeviceId is not an identity, so two unidentified callers must not
    // collapse into one another the way two subscriptions from one device do.
    expect(anonymousFirst).toHaveBeenCalledOnce()
    expect(anonymousSecond).toHaveBeenCalledOnce()
    expect(identified).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()
  })
})
