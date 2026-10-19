import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'
import { createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ID, subscribeFrame } from './bridge-host-test-harness'
import { BRIDGE_MAX_UNACKED_FRAMES, BridgeHostSubscriptions } from './bridge-host-subscriptions'
import {
  BridgeTerminalOutputBacklog,
  TERMINAL_STREAM_ACK_SILENCE_MS,
  type TerminalBacklogTimers
} from './bridge-terminal-output-backlog'

const HELD_OUTPUT = { type: 'data', streamId: 1, chunk: 'h'.repeat(48 * 1024) }

function manualTimers(): TerminalBacklogTimers & {
  pending: () => number
  delays: number[]
  fire: () => void
} {
  const handlers = new Map<unknown, () => void>()
  const delays: number[] = []
  let nextHandle = 0
  return {
    set: (handler, ms) => {
      nextHandle += 1
      handlers.set(nextHandle, handler)
      delays.push(ms)
      return nextHandle
    },
    clear: (handle) => {
      handlers.delete(handle)
    },
    pending: () => handlers.size,
    delays,
    fire: () => {
      for (const [handle, handler] of handlers) {
        handlers.delete(handle)
        handler()
      }
    }
  }
}

function emitWindowAndHold(onData: (payload: unknown) => void): void {
  for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES; index += 1) {
    onData({ type: 'data', streamId: 1, chunk: String(index) })
  }
  onData(HELD_OUTPUT)
}

function observeBacklogs(): BridgeTerminalOutputBacklog[] {
  const backlogs: BridgeTerminalOutputBacklog[] = []
  const hold = BridgeTerminalOutputBacklog.prototype.hold
  vi.spyOn(BridgeTerminalOutputBacklog.prototype, 'hold').mockImplementation(function (
    this: BridgeTerminalOutputBacklog,
    payload: unknown
  ) {
    if (!backlogs.includes(this)) {
      backlogs.push(this)
    }
    return hold.call(this, payload)
  })
  return backlogs
}

afterEach(() => vi.restoreAllMocks())

describe('bridge subscription start cleanup', () => {
  it('rethrows the original immediate failure without keeping a slot or timer', () => {
    const failure = new Error('subscribe failed')
    const timers = manualTimers()
    const subscriptions = new BridgeHostSubscriptions({
      client: {
        ...createFakeRpcClient(),
        subscribe: () => {
          throw failure
        }
      },
      post: vi.fn(),
      onBinaryFrameDropped: vi.fn(),
      terminalTimers: timers
    })

    expect(() => subscriptions.start(ID, 'terminal.subscribe', {})).toThrow(failure)
    expect(subscriptions.size).toBe(0)
    expect(timers.pending()).toBe(0)
    expect(timers.delays).toEqual([])
  })

  it('releases held output and its silence timer when subscribe emits and then throws', () => {
    const failure = new Error('subscribe failed after output')
    const timers = manualTimers()
    const backlogs = observeBacklogs()
    const subscriptions = new BridgeHostSubscriptions({
      client: {
        ...createFakeRpcClient(),
        subscribe: (_method, _params, onData) => {
          emitWindowAndHold(onData)
          expect(backlogs[0]?.pendingBytes).toBe(JSON.stringify(HELD_OUTPUT).length)
          expect(timers.pending()).toBe(1)
          throw failure
        }
      },
      post: vi.fn(),
      onBinaryFrameDropped: vi.fn(),
      terminalTimers: timers
    })

    let thrown: unknown
    try {
      subscriptions.start(ID, 'terminal.subscribe', {})
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(failure)
    expect(subscriptions.size).toBe(0)
    expect(backlogs).toHaveLength(1)
    expect({
      pendingBytes: backlogs[0]?.pendingBytes,
      held: backlogs[0]?.held,
      liveTimers: timers.pending()
    }).toEqual({ pendingBytes: 0, held: false, liveTimers: 0 })
    expect(timers.delays).toEqual([TERMINAL_STREAM_ACK_SILENCE_MS])
  })

  it('answers the original failure and leaves a same-ID replacement alive past the old deadline', () => {
    const client = createFakeRpcClient()
    const timers = manualTimers()
    let starts = 0
    const bridge = harness({
      ready: true,
      terminalTimers: timers,
      client: {
        ...client,
        subscribe: (method, params, onData, options) => {
          starts += 1
          if (starts === 1) {
            emitWindowAndHold(onData)
            throw new Error('failed after output')
          }
          return client.subscribe(method, params, onData, options)
        }
      }
    })

    bridge.host.receive(subscribeFrame(ID))
    expect(bridge.last()).toMatchObject({ type: 'error', id: ID })
    bridge.host.receive(subscribeFrame(ID))
    expect(client.streams).toHaveLength(1)
    timers.fire()
    expect(client.streams[0]?.unsubscribes).toBe(0)
    client.streams[0]?.emit({ type: 'data', streamId: 2, chunk: 'replacement still live' })
    expect(bridge.last()).toEqual({
      v: 1,
      type: 'event',
      id: ID,
      seq: 1,
      payload: { type: 'data', streamId: 2, chunk: 'replacement still live' }
    })
    expect(bridge.frames().filter((frame) => frame.type === 'end')).toEqual([])
    bridge.host.dispose()
    expect(client.streams[0]?.unsubscribes).toBe(1)
  })

  it('keeps a successful synchronous backlog until ack and unsubscribes once on cancel', () => {
    const timers = manualTimers()
    const backlogs = observeBacklogs()
    const unsubscribe = vi.fn()
    const subscriptions = new BridgeHostSubscriptions({
      client: {
        ...createFakeRpcClient(),
        subscribe: (_method, _params, onData) => {
          emitWindowAndHold(onData)
          return unsubscribe
        }
      },
      post: vi.fn(),
      onBinaryFrameDropped: vi.fn(),
      terminalTimers: timers
    })

    subscriptions.start(ID, 'terminal.subscribe', {})
    expect(subscriptions.has(ID)).toBe(true)
    expect(backlogs[0]?.pendingBytes).toBe(JSON.stringify(HELD_OUTPUT).length)
    expect(timers.pending()).toBe(1)
    subscriptions.ack(ID, BRIDGE_MAX_UNACKED_FRAMES)
    expect(backlogs[0]?.pendingBytes).toBe(0)
    expect(timers.pending()).toBe(0)
    subscriptions.cancel(ID, null)
    subscriptions.cancel(ID, null)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('preserves an overflow emitted before the original subscribe failure', () => {
    const failure = new Error('failure after overflow')
    const timers = manualTimers()
    const post = vi.fn()
    const subscriptions = new BridgeHostSubscriptions({
      client: {
        ...createFakeRpcClient(),
        subscribe: (_method, _params, onData) => {
          onData('z'.repeat(BRIDGE_MAX_MESSAGE_BYTES))
          throw failure
        }
      },
      post,
      onBinaryFrameDropped: vi.fn(),
      terminalTimers: timers
    })

    expect(() => subscriptions.start(ID, 'terminal.subscribe', {})).toThrow(failure)
    expect(post.mock.calls).toEqual([
      [JSON.stringify({ v: 1, type: 'end', id: ID, reason: 'overflow' })]
    ])
    expect(subscriptions.size).toBe(0)
    expect(timers.pending()).toBe(0)
  })
})
