import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'
import { RuntimeTerminalViewSubscribers } from '../runtime-terminal-view-subscribers'

async function subscribePausable(capabilities: Record<string, 1>) {
  const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
  const viewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: () => {},
    hasMobileSubscribers: () => false,
    isUnattachedLocalCandidate: () => false,
    attachProvider: () => null
  })
  const harness = startDesktopMultiplexSubscribe({
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      listeners.push(listener)
      return vi.fn()
    }),
    registerRemoteTerminalViewSubscriber: (ptyId, isOutputPaused) =>
      viewSubscribers.registerRemote(ptyId, isOutputPaused)
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  harness.handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 1,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities
        })
      })
    )!
  )
  const subscribedEvent = () =>
    harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed' && event.streamId === 1)
  await vi.waitFor(() => expect(subscribedEvent()).toBeDefined())
  let seq = 0
  let frameSeq = 10
  const setPaused = (paused: boolean): void =>
    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SetOutputPaused,
          streamId: 1,
          seq: frameSeq++,
          payload: encodeTerminalStreamJson({ paused })
        })
      )!
    )
  const emitOutput = (text: string): void => {
    seq += text.length
    listeners[0]?.(text, { seq, rawLength: text.length })
  }
  const dropNotices = (): number =>
    harness.binaryFrames.filter(
      (bytes) =>
        decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.PausedOutputDropped
    ).length
  const close = async (): Promise<void> => {
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  }
  const remoteViewHoldsAuthority = (): boolean => viewSubscribers.hasRemoteReceivingOutput('pty-1')
  return {
    subscribed: subscribedEvent(),
    setPaused,
    emitOutput,
    dropNotices,
    remoteViewHoldsAuthority,
    close
  }
}

describe('terminal multiplex paused-output drop notice', () => {
  it('announces a pause only when it actually discarded output', async () => {
    const host = await subscribePausable({ ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 })
    expect(host.subscribed.capabilities).toMatchObject({ outputPause: 1, outputPauseDropNotice: 1 })

    host.setPaused(true)
    host.setPaused(false)
    expect(host.dropNotices()).toBe(0)

    host.setPaused(true)
    host.emitOutput('hidden-1')
    host.emitOutput('hidden-2')
    expect(host.dropNotices()).toBe(1)
    host.setPaused(false)
    host.emitOutput('visible')
    expect(host.dropNotices()).toBe(1)

    // Each pause reports independently.
    host.setPaused(true)
    host.emitOutput('hidden-3')
    expect(host.dropNotices()).toBe(2)
    await host.close()
  })

  it('announces output still batched when the pause lands', async () => {
    const host = await subscribePausable({ ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 })
    host.emitOutput('batched-before-pause')
    host.setPaused(true)
    expect(host.dropNotices()).toBe(1)
    await host.close()
  })

  // #32944: the dropped output can carry a query, so main must answer it while this view is paused.
  it('yields query authority while paused and takes it back on resume and close', async () => {
    const host = await subscribePausable({ ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 })
    expect(host.remoteViewHoldsAuthority()).toBe(true)
    host.setPaused(true)
    expect(host.remoteViewHoldsAuthority()).toBe(false)
    host.setPaused(false)
    expect(host.remoteViewHoldsAuthority()).toBe(true)
    host.setPaused(true)
    await host.close()
    expect(host.remoteViewHoldsAuthority()).toBe(false)
  })

  it('never sends the frame to a client that did not negotiate it', async () => {
    const host = await subscribePausable({ ackOutput: 1, outputPause: 1 })
    expect(host.subscribed.capabilities?.outputPauseDropNotice).toBeUndefined()

    host.setPaused(true)
    host.emitOutput('hidden')
    host.setPaused(false)
    expect(host.dropNotices()).toBe(0)
    await host.close()
  })
})
