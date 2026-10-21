import './unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const request: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

function asRuntime(double: Record<string, unknown>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.subscribe reads only the members the double provides.
  return double as unknown as OrcaRuntimeService
}

type PaneDouble = {
  /** What the desktop renderer's serializer answers; null when no pane is registered. */
  rendererScreen: () => string | null
  /** How long each renderer serialize takes; the IPC answers null after 750 ms when no pane replies. */
  rendererAnswerDelayMs?: number
  /** PTY output high-water; a pane printing continuously advances it on every read. */
  outputSequence?: () => number
  /** Renderer-ordered seq; null when the pane does not order output itself. */
  rendererSeq?: number | null
  /** What the preference order serves before any renderer probe. */
  chosenScreen?: string
  /** Live output that arrives while the subscription is still buffering. */
  pendingOutput?: string
  /** Output offset at the end of the pending chunk. */
  pendingOutputSeq?: number
  waitForRendererTerminalSerializer: OrcaRuntimeService['waitForRendererTerminalSerializer']
}

function subscribeMobile(pane: PaneDouble) {
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const registry = createSubscriptionRegistryDouble()
  let emitData: (data: string, meta: { seq: number; rawLength: number }) => void = () => {}
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    // A daemon PTY reattached after a desktop restart has no headless model yet.
    hasHeadlessTerminalState: vi.fn(() => false),
    requestRendererTerminalTabMount: vi.fn(() => true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
    getRendererTerminalSerializerGeneration: vi.fn(() => 1),
    getPtyOutputSequence: vi.fn(pane.outputSequence ?? (() => 4)),
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
    waitForRendererTerminalSerializer: vi.fn(pane.waitForRendererTerminalSerializer),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn((_ptyId: string, listener: typeof emitData) => {
      emitData = listener
      return vi.fn()
    }),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    // The restored provider snapshot wins the preference order over the live renderer.
    serializeTerminalBuffer: vi.fn(async () => {
      if (pane.pendingOutput) {
        emitData(pane.pendingOutput, {
          seq: pane.pendingOutputSeq ?? 3,
          rawLength: pane.pendingOutput.length
        })
      }
      return {
        data: pane.chosenScreen ?? 'restored provider history',
        cols: 80,
        rows: 24,
        seq: 2
      }
    }),
    serializeRendererTerminalBuffer: vi.fn(async () => {
      if (pane.rendererAnswerDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, pane.rendererAnswerDelayMs))
      }
      const screen = pane.rendererScreen()
      const seq = pane.rendererSeq === undefined ? 4 : pane.rendererSeq
      return screen === null
        ? null
        : {
            data: screen,
            cols: 80,
            rows: 24,
            ...(seq === null ? {} : { seq }),
            source: 'renderer' as const
          }
    }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  }
  const dispatcher = new RpcDispatcher({ runtime: asRuntime(runtime), methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(request, vi.fn(), {
    connectionId: 'conn-phone',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    },
    registerBinaryStreamHandler: vi.fn(() => vi.fn())
  })
  const snapshotText = (): string =>
    binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
      .join('')
  const outputText = (): string =>
    binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
      .join('')
  const close = async (): Promise<void> => {
    runtime.cleanupSubscription('terminal-1:phone-1')
    await done
  }
  return { runtime, snapshotText, outputText, close }
}

describe('terminal subscribe for a pane the desktop already has mounted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('adopts the live renderer screen over the chosen snapshot without waiting out the mount deadline', async () => {
    // The renderer drops a mount request for a mounted tab, so no newer serializer settle ever arrives.
    const subscription = subscribeMobile({
      chosenScreen: 'suffix-only redraw',
      rendererScreen: () => 'live desktop prompt $ ',
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.snapshotText()).toContain('live desktop prompt $ ')
    expect(subscription.snapshotText()).not.toContain('suffix-only redraw')
    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(subscription.runtime.waitForRendererTerminalSerializer).not.toHaveBeenCalled()
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).toHaveBeenCalledWith('pty-1', expect.objectContaining({ data: 'live desktop prompt $ ' }), [])
    await subscription.close()
  })

  it('adopts a renderer-ordered screen even while output is pending', async () => {
    // The screen's seq (4) is an exact seam inside the pending chunk (offsets 3..5), so only `z` replays.
    const subscription = subscribeMobile({
      rendererScreen: () => 'ordered desktop prompt $ ',
      pendingOutput: 'Xz',
      pendingOutputSeq: 5,
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(subscription.snapshotText()).toContain('ordered desktop prompt $ ')
    expect(subscription.snapshotText()).not.toContain('restored provider history')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).toHaveBeenCalledWith(
      'pty-1',
      expect.objectContaining({ data: 'ordered desktop prompt $ ', seq: 4 }),
      [{ data: 'z', seq: 5 }]
    )
    expect(subscription.outputText()).toBe('z')
    await subscription.close()
  })

  it('answers at once for a mounted pane whose screen is still empty', async () => {
    // A fresh shell that has printed nothing: the serializer is registered but its screen is blank.
    const subscription = subscribeMobile({
      rendererScreen: () => '',
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    // A blank renderer must not erase history the chosen snapshot already carries.
    expect(subscription.snapshotText()).toContain('restored provider history')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).not.toHaveBeenCalled()
    await subscription.close()
  })

  it('answers at once for a mounted pane whose output never settles', async () => {
    // A desktop agent printing continuously: every renderer serialize races a new byte.
    let sequence = 4
    const subscription = subscribeMobile({
      rendererScreen: () => `agent frame ${sequence}`,
      outputSequence: () => (sequence += 1),
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(subscription.runtime.waitForRendererTerminalSerializer).not.toHaveBeenCalled()
    // An unsettled screen has no exact seam against buffered output, so the chosen snapshot goes out.
    expect(subscription.snapshotText()).toContain('restored provider history')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).not.toHaveBeenCalled()
    await subscription.close()
  })

  it('keeps the chosen snapshot for a seq-less mounted screen while output is pending', async () => {
    // Without a seq, the buffered chunk would replay on top of a screen that already holds it.
    const subscription = subscribeMobile({
      rendererScreen: () => 'unordered desktop prompt $ ',
      rendererSeq: null,
      pendingOutput: 'pending byte',
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(subscription.snapshotText()).toContain('restored provider history')
    expect(subscription.snapshotText()).not.toContain('unordered desktop prompt $ ')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).not.toHaveBeenCalled()
    await subscription.close()
  })

  it('adopts a seq-less mounted screen when no output is pending', async () => {
    // Right after a deferred cold restore the pane is not renderer-ordered yet; nothing can replay twice.
    const subscription = subscribeMobile({
      rendererScreen: () => 'unordered desktop prompt $ ',
      rendererSeq: null,
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(100)

    expect(subscription.runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(subscription.snapshotText()).toContain('unordered desktop prompt $ ')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).toHaveBeenCalledWith(
      'pty-1',
      expect.objectContaining({ data: 'unordered desktop prompt $ ' }),
      []
    )
    await subscription.close()
  })

  it('still requests the mount and waits for its settle when no pane is registered', async () => {
    let mounted = false
    const subscription = subscribeMobile({
      rendererScreen: () => (mounted ? 'mounted idle prompt $ ' : null),
      waitForRendererTerminalSerializer: (_ptyId, afterGeneration) => {
        expect(afterGeneration).toBe(1)
        return new Promise<boolean>((resolve) => {
          setTimeout(() => {
            mounted = true
            resolve(true)
          }, 500)
        })
      }
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(subscription.runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(subscription.snapshotText()).toBe('')
    // No pane is registered, so nothing may spend a terminal read (which can reach the provider) before the settle.
    expect(subscription.runtime.readTerminal).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(400)
    expect(subscription.snapshotText()).toContain('mounted idle prompt $ ')
    expect(subscription.snapshotText()).not.toContain('restored provider history')
    await subscription.close()
  })

  it('keeps the chosen snapshot after the mount wait when a seq-less screen meets pending output', async () => {
    let mounted = false
    const subscription = subscribeMobile({
      rendererScreen: () => (mounted ? 'unordered mounted prompt $ ' : null),
      rendererSeq: null,
      pendingOutput: 'pending byte',
      waitForRendererTerminalSerializer: () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            mounted = true
            resolve(true)
          }, 500)
        })
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(subscription.runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(subscription.snapshotText()).toContain('restored provider history')
    expect(
      subscription.runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery
    ).not.toHaveBeenCalled()
    await subscription.close()
  })

  it('falls back to the mount wait within one serialize when the flag outlives its pane', async () => {
    // Nothing clears the flag when a tab closes over a live PTY; the IPC then answers null at its
    // 750 ms deadline while a busy PTY moves output under every attempt.
    let sequence = 4
    const subscription = subscribeMobile({
      rendererScreen: () => null,
      rendererAnswerDelayMs: 750,
      outputSequence: () => (sequence += 1),
      waitForRendererTerminalSerializer: (_ptyId, _after, _timeout, signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    })

    await vi.advanceTimersByTimeAsync(750)
    expect(subscription.runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    await vi.advanceTimersByTimeAsync(2_999)
    expect(subscription.snapshotText()).toBe('')

    // Worst case: one serialize plus the 3 s mount deadline.
    await vi.advanceTimersByTimeAsync(1)
    expect(subscription.snapshotText()).toContain('restored provider history')
    expect(subscription.runtime.serializeRendererTerminalBuffer).toHaveBeenCalledTimes(1)
    await subscription.close()
  })
})
