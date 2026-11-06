import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'
import { RuntimeTerminalViewSubscribers } from '../terminal/view/runtime-terminal-view-subscribers'

async function subscribeDesktop(capabilities: Record<string, 1>) {
  const viewSubscribers = new RuntimeTerminalViewSubscribers({
    notifyPresenceChanged: () => {},
    hasMobileSubscribers: () => false,
    ensureProviderAttach: () => {}
  })
  // Mirrors OrcaRuntime: only a view that reports hidden panes may count as showing one.
  const harness = startDesktopMultiplexSubscribe({
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: (
      ptyId,
      isOutputPaused,
      _mobileClientId,
      reportsHiddenPane
    ) =>
      viewSubscribers.registerRemote(
        ptyId,
        isOutputPaused,
        reportsHiddenPane ? isOutputPaused : undefined
      )
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
  await vi.waitFor(() =>
    expect(
      harness.messages
        .map((message) => JSON.parse(message).result)
        .some((event) => event?.type === 'subscribed' && event.streamId === 1)
    ).toBe(true)
  )
  let frameSeq = 10
  return {
    shown: () => viewSubscribers.isShownRemotely('pty-1'),
    setPaused: (paused: boolean): void =>
      harness.handlers.get(1)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SetOutputPaused,
            streamId: 1,
            seq: frameSeq++,
            payload: encodeTerminalStreamJson({ paused })
          })
        )!
      ),
    close: async (): Promise<void> => {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
}

describe('a paired desktop showing a terminal (#36427)', () => {
  it('counts as showing it until it hides the pane or disconnects', async () => {
    const client = await subscribeDesktop({ outputPause: 1, paneVisibility: 1 })
    expect(client.shown()).toBe(true)
    client.setPaused(true)
    expect(client.shown()).toBe(false)
    client.setPaused(false)
    expect(client.shown()).toBe(true)
    await client.close()
    expect(client.shown()).toBe(false)
  })

  it('never counts a client too old to report hidden panes', async () => {
    const client = await subscribeDesktop({})
    expect(client.shown()).toBe(false)
    await client.close()
  })

  it('never counts a pausable reader that is not a terminal pane, such as a dashboard preview', async () => {
    const client = await subscribeDesktop({ outputPause: 1 })
    expect(client.shown()).toBe(false)
    await client.close()
  })
})
