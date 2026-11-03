import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import { stubRuntime } from './terminal-multiplex-test-harness'

const subscriptionParams = {
  terminal: 'terminal-late-renderer',
  client: { id: 'phone-late-renderer', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1 }
}
const request: RpcRequest = {
  id: 'req-late-renderer',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: subscriptionParams
}

afterEach(() => {
  vi.useRealTimers()
})

async function lateRendererRecovery({
  outputDuringDeepRead = false,
  multiplex = false,
  resize = false,
  holdCredit = true
}: {
  outputDuringDeepRead?: boolean
  multiplex?: boolean
  resize?: boolean
  holdCredit?: boolean
} = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const registry = createSubscriptionRegistryDouble()
  let outputSequence = 5
  let rendererReady!: (ready: boolean) => void
  let mounted = false
  let onData: ((data: string, meta: { seq: number; rawLength: number }) => void) | undefined
  let onResize:
    | ((event: { cols: number; rows: number; displayMode: string; reason: string }) => void)
    | undefined
  const emit = (data: string) => {
    outputSequence += data.length
    onData?.(data, { seq: outputSequence, rawLength: data.length })
  }
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const send = (streamId: number, opcode: TerminalStreamOpcode, payload: unknown) =>
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          streamId,
          opcode,
          seq: 0,
          payload: encodeTerminalStreamJson(payload)
        })
      )!
    )
  const serializeRendererTerminalBuffer = vi.fn(
    async (_ptyId: string, opts?: { scrollbackRows?: number }) => {
      if (!mounted) {
        return null
      }
      if (opts?.scrollbackRows === 5000) {
        if (outputDuringDeepRead) {
          outputSequence += 1
        }
        return { data: 'desktop history', cols: 80, rows: 24, seq: outputSequence }
      }
      return { data: 'phone history', cols: 80, rows: 24, seq: outputSequence }
    }
  )
  const replaceHeadlessTerminalFromRendererSnapshotForRecovery =
    vi.fn<(ptyId: string, seed: { data: string }) => void>()
  const runtime = stubRuntime({
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-late' }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-late' }),
    hasHeadlessTerminalState: vi.fn(() => false),
    requestRendererTerminalTabMount: vi.fn(() => true),
    getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
    getRendererTerminalSerializerGeneration: vi.fn(() => 1),
    waitForRendererTerminalSerializer: vi.fn(
      () => new Promise<boolean>((resolve) => (rendererReady = resolve))
    ),
    getPtyOutputSequence: vi.fn(() => outputSequence),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      onData = listener
      return vi.fn()
    }),
    isSoleRemoteTerminalQueryOwner: () => true,
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(async () => {
      if (mounted && resize && !holdCredit) {
        emit('covered')
      }
      return mounted ? { data: 'phone history', cols: 90, rows: 24, seq: outputSequence } : null
    }),
    serializeRendererTerminalBuffer,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery,
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn((_ptyId, listener) => {
      onResize = listener
      return vi.fn()
    }),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    multiplex ? { ...request, method: 'terminal.multiplex', params: {} } : request,
    vi.fn(),
    {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: (id, handler) => {
        handlers.set(id, handler)
        return () => handlers.delete(id)
      }
    }
  )
  if (multiplex) {
    await vi.advanceTimersByTimeAsync(0)
    send(0, TerminalStreamOpcode.Subscribe, {
      ...subscriptionParams,
      streamId: 7,
      capabilities: { ackOutput: 1 }
    })
  }
  // The mount wait times out, so the late renderer arrives through the live recovery path.
  await vi.advanceTimersByTimeAsync(3_000)
  if (multiplex && !resize) {
    emit('x'.repeat(512 * 1024))
    emit('covered\x1b[c')
    await vi.advanceTimersByTimeAsync(5)
  }
  mounted = true
  rendererReady(true)
  const sentSnapshots = () =>
    binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
  await vi.waitFor(() => expect(sentSnapshots()).toContain('phone history'))
  await vi.waitFor(() =>
    expect(serializeRendererTerminalBuffer).toHaveBeenLastCalledWith('pty-late', {
      scrollbackRows: 5000
    })
  )
  await vi.advanceTimersByTimeAsync(0)
  const seeds = replaceHeadlessTerminalFromRendererSnapshotForRecovery.mock.calls.map(
    ([, seed]) => seed.data
  )
  if (resize) {
    if (holdCredit) {
      emit('x'.repeat(512 * 1024))
      emit('covered\x1b[c')
      await vi.advanceTimersByTimeAsync(5)
    }
    onResize?.({ cols: 90, rows: 24, displayMode: 'auto', reason: 'apply-layout' })
    await vi.advanceTimersByTimeAsync(0)
  }
  const recoveryEnd =
    binaryFrames.findLastIndex(
      (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotEnd
    ) + 1
  if (multiplex) {
    outputSequence += 4
    onData?.('TAIL', { seq: outputSequence, rawLength: 4 })
    await vi.advanceTimersByTimeAsync(5)
    send(7, TerminalStreamOpcode.Ack, { bytes: 512 * 1024 })
  }
  const outputAfterRecovery = binaryFrames
    .slice(recoveryEnd)
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    .map((frame) => decodeTerminalStreamText(frame!.payload))
    .join('')
  runtime.cleanupSubscription(
    multiplex ? 'terminal-multiplex:conn-phone' : 'terminal-late-renderer:phone-late-renderer'
  )
  await dispatchPromise
  return { seeds, sent: sentSnapshots(), outputAfterRecovery }
}

describe('late renderer recovery keeps desktop history in main', () => {
  it.each([true, false])(
    'reconciles mobile width-restream output with held credits %s',
    async (holdCredit) => {
      const { outputAfterRecovery } = await lateRendererRecovery({
        multiplex: true,
        resize: true,
        holdCredit
      })
      expect(outputAfterRecovery).toBe(holdCredit ? '\x1b[cTAIL' : 'TAIL')
    }
  )
  it('replays only owed queries and the exact live tail after an ACK-blocked multiplex recovery', async () => {
    const { outputAfterRecovery } = await lateRendererRecovery({ multiplex: true })
    expect(outputAfterRecovery).toBe('\x1b[cTAIL')
  })
  it('publishes the phone recovery, then deepens main to desktop depth', async () => {
    const { seeds, sent } = await lateRendererRecovery()
    expect(sent).toContain('phone history')
    expect(seeds).toEqual(['phone history', 'desktop history'])
  })

  it('still publishes the phone recovery when output lands during the deeper read', async () => {
    const { seeds, sent } = await lateRendererRecovery({ outputDuringDeepRead: true })
    expect(sent).toContain('phone history')
    expect(seeds).toEqual(['phone history'])
  })
})
