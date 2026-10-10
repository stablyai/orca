import { describe, expect, it, vi } from 'vitest'
import { encodeBrowserScreencastFrame } from '../../shared/browser-screencast-protocol'
import type { BrowserScreencastResult } from '../../shared/runtime-types'
import { RuntimeBrowserScreencastController } from './runtime-browser-screencast-controller'

const frame = (seq: number) =>
  encodeBrowserScreencastFrame({
    opcode: 1,
    format: 'jpeg',
    seq,
    metadata: {},
    image: new Uint8Array([seq])
  })

function startStream(ackWindow?: number) {
  let gate: ((bytes: Uint8Array) => boolean | void) | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const flushPendingFrame = vi.fn()
  const commands = {
    browserScreencast: vi.fn(async (_params: unknown, stream: { sendBinary: typeof gate }) => {
      gate = stream.sendBinary
      return {
        subscriptionId: 'sub-1',
        flushPendingFrame,
        session: { done, stop: finish, updateViewport: vi.fn() },
        ready: {
          type: 'ready' as const,
          subscriptionId: 'sub-1',
          browserPageId: 'page-1',
          format: 'jpeg' as const,
          tab: { browserPageId: 'page-1', index: 0, url: '', title: '', active: true }
        }
      }
    })
  }
  const controller = new RuntimeBrowserScreencastController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements the only command the controller calls.
    getCommands: () => commands as never,
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    getDriver: () => ({ kind: 'idle' }),
    setDriver: vi.fn(),
    notifyRemoteViewersChanged: vi.fn()
  })
  const socket = vi.fn((_bytes: Uint8Array) => true)
  const events: BrowserScreencastResult[] = []
  const running = controller.start(
    { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg', ackWindow },
    { connectionId: 'conn-1', sendBinary: socket, emit: (event) => events.push(event) }
  )
  const send = (seq: number) => gate?.(frame(seq))
  return { controller, events, socket, send, flushPendingFrame, finish, running }
}

describe('RuntimeBrowserScreencastController frame acks', () => {
  it('holds frames past the viewer window until it acks, then offers the kept frame again', async () => {
    const stream = startStream(2)
    await vi.waitFor(() => expect(stream.events).toHaveLength(1))
    expect(stream.events[0]).toMatchObject({ type: 'ready', frameAck: { window: 2 } })
    expect([stream.send(1), stream.send(2), stream.send(3)]).toEqual([true, true, false])
    expect(stream.socket).toHaveBeenCalledTimes(2)
    stream.controller.ack('sub-1', 1, 'other-connection')
    expect(stream.flushPendingFrame).toHaveBeenCalledTimes(1)
    stream.controller.ack('sub-1', 1, 'conn-1')
    expect(stream.flushPendingFrame).toHaveBeenCalledTimes(2)
    expect(stream.send(3)).toBe(true)
    stream.finish()
    await stream.running
  })

  it('sends every frame to a viewer that did not ask for acks', async () => {
    const stream = startStream()
    await vi.waitFor(() => expect(stream.events).toHaveLength(1))
    expect(stream.events[0]).not.toHaveProperty('frameAck')
    expect([1, 2, 3, 4].map(stream.send)).toEqual([true, true, true, true])
    stream.finish()
    await stream.running
  })
})
