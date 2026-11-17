import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../../terminal/output/runtime-terminal-stream-consumers'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  TERMINAL_STREAM_CHUNK_BYTES
} from '../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { startDesktopMultiplexSubscribe } from './testing/terminal-multiplex-test-harness'
import { RuntimeTerminalViewSubscribers } from '../../terminal/view/runtime-terminal-view-subscribers'

async function subscribePausable(
  capabilities: Record<string, 1>,
  answerYieldedTerminalQueries = vi.fn()
) {
  const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
  const viewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: () => {},
    hasMobileSubscribers: () => false,
    ensureProviderAttach: () => {}
  })
  const harness = startDesktopMultiplexSubscribe({
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      listeners.push(listener)
      return vi.fn()
    }),
    registerRemoteTerminalViewSubscriber: (ptyId, isOutputPaused) =>
      viewSubscribers.registerRemote(ptyId, isOutputPaused),
    isSoleRemoteTerminalQueryOwner: (ptyId) =>
      viewSubscribers.remoteAnsweringQueriesCount(ptyId) === 1,
    answerYieldedTerminalQueries
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
  const outputText = (): string =>
    harness.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .map((frame) =>
        frame?.opcode === TerminalStreamOpcode.Output ? decodeTerminalStreamText(frame.payload) : ''
      )
      .join('')
  const close = async (): Promise<void> => {
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  }
  const remoteViewHoldsAuthority = (): boolean => viewSubscribers.hasRemoteAnsweringQueries('pty-1')
  return {
    subscribed: subscribedEvent(),
    setPaused,
    emitOutput,
    dropNotices,
    outputText,
    remoteViewHoldsAuthority,
    viewSubscribers,
    close
  }
}

describe('terminal multiplex paused-output drop notice', () => {
  // #32944: main yielded the batched bytes' replies to this view, so a DA1 dropped here went unanswered.
  it('delivers output still batched when the pause lands', async () => {
    const host = await subscribePausable({ ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 })
    host.emitOutput('batched-before-pause\x1b[c')
    host.setPaused(true)
    expect(host.outputText()).toContain('batched-before-pause\x1b[c')
    expect(host.dropNotices()).toBe(0)
    await host.close()
  })

  const fillAckWindow = (host: { emitOutput: (text: string) => void }): void => {
    for (let i = 0; i <= TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES / (64 * 1024); i++) {
      host.emitOutput('x'.repeat(64 * 1024))
    }
  }

  // #32944: output parked behind a full ACK window is discarded on pause; main must answer its queries.
  it('hands queries in discarded ACK-pending output back to main', async () => {
    const answerYieldedTerminalQueries = vi.fn()
    const host = await subscribePausable(
      { ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 },
      answerYieldedTerminalQueries
    )
    fillAckWindow(host)
    host.emitOutput('prompt\x1b[')
    host.emitOutput('c')
    host.setPaused(true)
    expect(host.outputText()).not.toContain('\x1b[c')
    expect(answerYieldedTerminalQueries).toHaveBeenCalledWith('pty-1', '\x1b[c')
    await host.close()
  })

  it('does not re-answer a query whose sub-frame of a large event was delivered', async () => {
    const answerYieldedTerminalQueries = vi.fn()
    const host = await subscribePausable(
      { ackOutput: 1, outputPause: 1, outputPauseDropNotice: 1 },
      answerYieldedTerminalQueries
    )
    for (let i = 1; i < TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES / (64 * 1024); i++) {
      host.emitOutput('x'.repeat(64 * 1024))
    }
    host.emitOutput(`prompt\x1b[c${'y'.repeat(2 * TERMINAL_STREAM_CHUNK_BYTES)}`)
    host.setPaused(true)
    expect(host.outputText()).toContain('prompt\x1b[c')
    expect(answerYieldedTerminalQueries).not.toHaveBeenCalled()
    await host.close()
  })
})
