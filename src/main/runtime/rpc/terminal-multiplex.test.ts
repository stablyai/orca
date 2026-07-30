/* oxlint-disable max-lines -- Why: multiplex transport tests share a live dispatcher harness; splitting it would duplicate stream setup and weaken race coverage. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService, RuntimeTerminalDataMeta } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
} from '../../../shared/terminal-multiplex-flow-control'
import { SshPtyOutputIntake, type SshPtyOutputDataEvent } from '../../ipc/ssh-pty-output-intake'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  const serializeAuthoritativeTerminalBuffer =
    overrides.serializeAuthoritativeTerminalBuffer ??
    ((ptyId: string, opts?: { scrollbackRows?: number }) =>
      overrides.serializeTerminalBuffer?.(ptyId, opts))
  return {
    getRuntimeId: () => 'test-runtime',
    // Why: every multiplex stream registers as a remote view subscriber for
    // Phase-5 query-authority suppression (terminal-query-authority.md).
    registerRemoteTerminalViewSubscriber: () => () => {},
    // Why: the multiplex subscribe path resolves handles via
    // resolveLiveLeafForHandle (#7718). Default to a live pty so tests that
    // only stub the legacy resolveLeafForHandle still bind; tests that need a
    // null/stale leaf override this explicitly.
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    serializeAuthoritativeTerminalBuffer,
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function startDesktopMultiplexSubscribe(
  overrides: Partial<OrcaRuntimeService> = {},
  trace?: string[],
  sendBinaryOverride?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
) {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const cleanups = new Map<string, () => void>()
  const runtime = stubRuntime({
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
    }),
    ...overrides,
    waitForTerminal:
      overrides.waitForTerminal ?? vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => {
      messages.push(msg)
      const type = JSON.parse(msg).result?.type
      if (type) {
        trace?.push(type)
      }
    },
    {
      connectionId: 'conn-desktop-first-paint',
      sendBinary: (bytes) => {
        const sent = sendBinaryOverride?.(bytes)
        if (sent === false) {
          return false
        }
        binaryFrames.push(bytes)
        const opcode = decodeTerminalStreamFrame(bytes)?.opcode
        if (
          opcode === TerminalStreamOpcode.SnapshotStart ||
          opcode === TerminalStreamOpcode.SnapshotChunk ||
          opcode === TerminalStreamOpcode.SnapshotEnd
        ) {
          trace?.push('snapshot')
        }
        return sent
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => {
          if (handlers.get(streamId) === handler) {
            handlers.delete(streamId)
          }
        }
      }
    }
  )
  return { messages, binaryFrames, handlers, cleanups, runtime, dispatchPromise }
}

function sendDesktopMultiplexSubscribe(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>
) {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { ackOutput: 1, desktopViewportClaims: 1 },
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
}

function sendDesktopSourceRangeSubscribe(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>
) {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
        })
      })
    )!
  )
}

function sourceRange(start: number, end: number) {
  return {
    id: 'pty-1',
    spanId: `span-${start}-${end}`,
    providerGeneration: 5,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    sourceStartSu: start,
    sourceEndSu: end,
    displayStart: start,
    displayEnd: end,
    splittable: true,
    transform: { transformed: false, rawLengthSu: end - start, scalarSafe: true }
  } as const
}

async function acknowledgeSourceRangeOverflow(
  harness: ReturnType<typeof startDesktopMultiplexSubscribe>,
  dataListener: (data: string, meta?: RuntimeTerminalDataMeta) => void,
  data: string,
  acknowledge: 'all' | 'first' = 'all'
) {
  await vi.waitFor(() =>
    expect(
      harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
    ).toBe(true)
  )
  const subscribed = harness.messages
    .map((message) => JSON.parse(message).result)
    .find((event) => event?.type === 'subscribed')
  harness.binaryFrames.splice(0)
  dataListener(data, {
    seq: data.length,
    rawLength: data.length,
    sourceRanges: [sourceRange(0, data.length)]
  })
  const outputFrames = harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
  const acceptedEndByte = outputFrames.reduce(
    (total, frame) => total + (frame?.payload.byteLength ?? 0),
    0
  )
  const ackedEndByte =
    acknowledge === 'first' ? (outputFrames[0]?.payload.byteLength ?? 0) : acceptedEndByte
  expect(ackedEndByte).toBeGreaterThan(0)
  harness.handlers.get(7)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Ack,
        streamId: 7,
        seq: 2,
        payload: encodeTerminalStreamJson({
          streamGeneration: subscribed.streamGeneration,
          ackedEndByte
        })
      })
    )!
  )
  return { acceptedEndByte, ackedEndByte, streamGeneration: subscribed.streamGeneration }
}

type OverflowRecoverySnapshot = {
  data: string
  cols: number
  rows: number
  source?: 'headless' | 'renderer'
  seq?: number
}

function startSourceRangeOverflowHarness(options: {
  recover: () => Promise<OverflowRecoverySnapshot>
  commit?: () => boolean
  onFrame?: (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => boolean | void
}) {
  let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
  const lifecycle: string[] = []
  const reserve = vi.fn((identity, requiredSeq: number, reason: string) => {
    if (reason !== 'ack-pending-overflow') {
      return null
    }
    lifecycle.push('reserve')
    return Object.freeze({
      reservationId: 'overflow-replacement',
      identity: Object.freeze({ ...identity }),
      requiredSeq
    })
  })
  const commit = vi.fn(() => {
    lifecycle.push('commit')
    return options.commit?.() ?? true
  })
  const rollback = vi.fn(() => {
    lifecycle.push('rollback')
    return true
  })
  const cancel = vi.fn(() => {
    lifecycle.push('cancel')
  })
  const harness = startDesktopMultiplexSubscribe(
    {
      attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
      settleRemoteTerminalSourceRanges: vi.fn(),
      reserveRemoteTerminalSourceRangeReplacement: reserve,
      commitRemoteTerminalSourceRangeReplacement: commit,
      rollbackRemoteTerminalSourceRangeReplacement: rollback,
      cancelRemoteTerminalSourceRanges: cancel,
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({
          data: 'initial snapshot',
          cols: 120,
          rows: 40,
          source: 'headless',
          seq: 0
        })
        .mockImplementationOnce(options.recover),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    },
    undefined,
    (bytes) => {
      const frame = decodeTerminalStreamFrame(bytes)
      return frame ? options.onFrame?.(frame) : undefined
    }
  )
  return {
    ...harness,
    lifecycle,
    reserve,
    commit,
    rollback,
    cancel,
    getDataListener: () => dataListener
  }
}

describe('terminal multiplex RPC', () => {
  it.each(['headless', 'renderer'] as const)(
    'commits a source-range replacement only after the %s snapshot publishes',
    async (source) => {
      const reservation = {
        reservationId: 'replacement-1',
        identity: {
          ptyId: 'pty-1',
          consumerId: 'multiplex:conn-desktop-first-paint:7',
          streamGeneration: 'generation'
        },
        requiredSeq: 4
      }
      const reserve = vi.fn(() => reservation)
      const commit = vi.fn(() => true)
      const rollback = vi.fn(() => true)
      const harness = startDesktopMultiplexSubscribe({
        attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
        reserveRemoteTerminalSourceRangeReplacement: reserve,
        commitRemoteTerminalSourceRangeReplacement: commit,
        rollbackRemoteTerminalSourceRangeReplacement: rollback,
        cancelRemoteTerminalSourceRanges: vi.fn(),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40, source, seq: 4 })
      })
      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 7,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
            })
          })
        )!
      )

      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce())
      expect(reserve).toHaveBeenCalledWith(expect.any(Object), 4, 'initial-snapshot')
      expect(commit).toHaveBeenCalledWith(reservation, { source, seq: 4 })
      expect(rollback).not.toHaveBeenCalled()
      const snapshotEndIndex = harness.binaryFrames.findIndex(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotEnd
      )
      expect(snapshotEndIndex).toBeGreaterThanOrEqual(0)
      harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
      await harness.dispatchPromise
    }
  )

  it.each([
    { topology: 'headed renderer snapshot semantics', source: 'renderer' as const },
    { topology: 'headless model snapshot semantics', source: 'headless' as const }
  ])(
    'admits only snapshot-covered source spans for a $topology and delivers the trailing span live',
    async ({ source }) => {
      let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
      let modelSequence = 0
      let resolveSnapshot: (
        value: Readonly<{
          data: string
          cols: number
          rows: number
          source: 'headless' | 'renderer'
          seq: number
        }>
      ) => void = () => {}
      const publishedSourceEnds: number[] = []
      const prepareExit = vi.fn()
      const finalizeExit = vi.fn()
      const closeProvider = vi.fn()
      const intake = new SshPtyOutputIntake({
        getModelSequence: () => modelSequence,
        acceptModel: (event, projection) => {
          modelSequence = projection.identity.sequenceEnd
          dataListener?.(event.data, {
            seq: modelSequence,
            rawLength: event.rawLength,
            sourceRanges: projection.desktopSpan ? [projection.desktopSpan] : undefined
          })
          return { sequence: modelSequence, completion: Promise.resolve() }
        },
        project: vi.fn(),
        prepareExit,
        finalizeExit,
        closeProvider,
        publishSourceAck: (_providerGeneration, batch, onSettled) => {
          publishedSourceEnds.push(
            ...batch.acknowledgements.map((acknowledgement) => acknowledgement.creditedEndSu)
          )
          onSettled({ ok: true })
        }
      })
      const hooks = intake.getRemoteSourceRangeConsumerHooks()
      const reserveReplacement = vi.fn(hooks.reserveReplacement)
      const harness = startDesktopMultiplexSubscribe({
        attachRemoteTerminalSourceRangeConsumer: hooks.attach,
        settleRemoteTerminalSourceRanges: hooks.settle,
        reserveRemoteTerminalSourceRangeReplacement: reserveReplacement,
        commitRemoteTerminalSourceRangeReplacement: hooks.commitReplacement,
        rollbackRemoteTerminalSourceRangeReplacement: hooks.rollbackReplacement,
        cancelRemoteTerminalSourceRanges: hooks.cancel,
        subscribeToTerminalData: vi.fn((_ptyId, listener) => {
          dataListener = listener
          return vi.fn()
        }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              source: 'headless' | 'renderer'
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        )
      })
      const sourceEvent = (
        spanId: string,
        data: string,
        sourceStartSu: number
      ): SshPtyOutputDataEvent => ({
        id: 'pty-1',
        data,
        providerGeneration: 9,
        ptyIncarnation: 'incarnation-1',
        rawLength: data.length,
        transformed: false,
        source: {
          spanId,
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'delivery-1',
          sourceStartSu,
          sourceEndSu: sourceStartSu + data.length
        }
      })
      const settleDesktop = async (event: SshPtyOutputDataEvent): Promise<void> => {
        const receipt = await intake.acceptData(event)
        const projectionId = receipt.projection.identity.projectionSemanticsId
        intake.publishProjectionPrefix([projectionId], event.data.length, event.rawLength)
        expect(intake.settleProjectionPrefix(event.id, event.rawLength)).toBe(event.rawLength)
      }

      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 7,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
            })
          })
        )!
      )
      await vi.waitFor(() => expect(dataListener).toBeDefined())
      await settleDesktop(sourceEvent('span-covered', 'snap', 0))
      await settleDesktop(sourceEvent('span-trailing', 'live', 4))
      expect(reserveReplacement).not.toHaveBeenCalled()

      resolveSnapshot({ data: 'snap', cols: 120, rows: 40, source, seq: 4 })
      await vi.waitFor(() => expect(reserveReplacement).toHaveBeenCalledOnce())
      expect(reserveReplacement).toHaveBeenCalledWith(expect.any(Object), 4, 'initial-snapshot')
      await vi.waitFor(() => expect(publishedSourceEnds).toEqual([4]))

      const subscribed = harness.messages
        .map((message) => JSON.parse(message).result)
        .find((event) => event?.type === 'subscribed')
      const liveOutput = harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .find((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      const snapshotOutput = harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
      expect(snapshotOutput).toBe('snap')
      expect(liveOutput && decodeTerminalStreamText(liveOutput.payload)).toBe('live')
      harness.handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: 7,
            seq: 2,
            payload: encodeTerminalStreamJson({
              streamGeneration: subscribed.streamGeneration,
              ackedEndByte: liveOutput!.payload.byteLength
            })
          })
        )!
      )
      await vi.waitFor(() => expect(publishedSourceEnds).toEqual([4, 8]))
      await intake.acceptExit({
        id: 'pty-1',
        code: 0,
        providerGeneration: 9,
        ptyIncarnation: 'incarnation-1'
      })
      expect(prepareExit).toHaveBeenCalledOnce()
      expect(finalizeExit).toHaveBeenCalledOnce()
      expect(closeProvider).not.toHaveBeenCalled()
      expect(intake.getDebugSnapshot().source).toEqual({
        openedTokens: 0,
        ptyIdentities: 0
      })

      harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
      await harness.dispatchPromise
      intake.dispose()
    }
  )

  it('rolls back replacement admission when snapshot publication is refused', async () => {
    const reservation = {
      reservationId: 'replacement-1',
      identity: {
        ptyId: 'pty-1',
        consumerId: 'multiplex:conn-desktop-first-paint:7',
        streamGeneration: 'generation'
      },
      requiredSeq: 4
    }
    const commit = vi.fn(() => true)
    const rollback = vi.fn(() => true)
    const harness = startDesktopMultiplexSubscribe(
      {
        attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
        reserveRemoteTerminalSourceRangeReplacement: vi.fn(() => reservation),
        commitRemoteTerminalSourceRangeReplacement: commit,
        rollbackRemoteTerminalSourceRangeReplacement: rollback,
        cancelRemoteTerminalSourceRanges: vi.fn(),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40,
          source: 'headless',
          seq: 4
        })
      },
      undefined,
      (bytes) => decodeTerminalStreamFrame(bytes)?.opcode !== TerminalStreamOpcode.SnapshotEnd
    )
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
          })
        })
      )!
    )

    await harness.dispatchPromise
    expect(commit).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledWith(reservation, 'stream-detached-replacement-aborted')
  })

  it('keeps legacy multiplex clients outside source replacement admission', async () => {
    const attach = vi.fn(() => true)
    const reserve = vi.fn()
    const harness = startDesktopMultiplexSubscribe({
      attachRemoteTerminalSourceRangeConsumer: attach,
      reserveRemoteTerminalSourceRangeReplacement: reserve
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )

    expect(attach).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('keeps stale parsed source ACKs from releasing in-flight byte credit', async () => {
    let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | null = null
    const settle = vi.fn()
    const cancel = vi.fn()
    const harness = startDesktopMultiplexSubscribe({
      attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
      settleRemoteTerminalSourceRanges: settle,
      reserveRemoteTerminalSourceRangeReplacement: vi.fn(() => null),
      commitRemoteTerminalSourceRangeReplacement: vi.fn(() => false),
      rollbackRemoteTerminalSourceRangeReplacement: vi.fn(() => false),
      cancelRemoteTerminalSourceRanges: cancel,
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    harness.handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(dataListener).not.toBeNull())
    await vi.waitFor(() =>
      expect(
        harness.messages
          .map((message) => JSON.parse(message).result)
          .find((event) => event?.type === 'subscribed')
      ).toBeDefined()
    )
    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed')
    expect(subscribed).toMatchObject({
      capabilities: { ackOutputSourceRanges: 1 },
      streamGeneration: expect.any(String)
    })

    const emitData = dataListener as unknown as (
      data: string,
      meta?: RuntimeTerminalDataMeta
    ) => void
    emitData('ab', {
      seq: 2,
      rawLength: 2,
      sourceRanges: [
        {
          id: 'pty-1',
          spanId: 'span-1',
          providerGeneration: 5,
          clientGeneration: 2,
          ownerGeneration: 3,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'token-1',
          sourceStartSu: 0,
          sourceEndSu: 2,
          displayStart: 0,
          displayEnd: 2,
          splittable: true,
          transform: { transformed: false, rawLengthSu: 2, scalarSafe: true }
        }
      ]
    })
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.some(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
        )
      ).toBe(true)
    )
    const output = harness.binaryFrames
      .map(decodeTerminalStreamFrame)
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Output)!
    const acknowledge = (payload: unknown): void => {
      harness.handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: 7,
            seq: 2,
            payload: encodeTerminalStreamJson(payload)
          })
        )!
      )
    }

    acknowledge({
      streamGeneration: subscribed.streamGeneration,
      ackedEndByte: output.payload.byteLength - 1
    })
    acknowledge({
      streamGeneration: subscribed.streamGeneration,
      ackedEndByte: output.payload.byteLength + 1
    })
    acknowledge({ bytes: output.payload.byteLength })
    acknowledge({ epoch: 'notification', watermark: output.payload.byteLength })
    const fillLength = TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
    emitData('x'.repeat(fillLength), {
      seq: output.payload.byteLength + fillLength,
      rawLength: fillLength,
      sourceRanges: [sourceRange(output.payload.byteLength, output.payload.byteLength + fillLength)]
    })
    emitData('y'.repeat(64 * 1024), {
      seq: output.payload.byteLength + fillLength + 64 * 1024,
      rawLength: 64 * 1024,
      sourceRanges: [
        sourceRange(
          output.payload.byteLength + fillLength,
          output.payload.byteLength + fillLength + 64 * 1024
        )
      ]
    })
    const outputFramesBeforeStaleAck = harness.binaryFrames.filter(
      (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
    ).length
    acknowledge({ streamGeneration: 'stale', ackedEndByte: output.payload.byteLength })
    expect(settle).not.toHaveBeenCalled()
    expect(
      harness.binaryFrames.filter(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
      )
    ).toHaveLength(outputFramesBeforeStaleAck)

    acknowledge({
      streamGeneration: subscribed.streamGeneration,
      ackedEndByte: output.payload.byteLength
    })
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ streamGeneration: subscribed.streamGeneration }),
      [expect.objectContaining({ spanId: 'span-1', sourceStartSu: 0, sourceEndSu: 2 })]
    )
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 3,
          payload: new Uint8Array()
        })
      )!
    )
    expect(cancel).toHaveBeenCalledWith(
      expect.any(Object),
      expect.arrayContaining([expect.objectContaining({ spanId: `span-2-${2 + fillLength}` })]),
      'stream-detached'
    )
  })

  it('keeps a lossless stream attached across partial ACK and source-token rotation', async () => {
    let dataListener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | null = null
    const settle = vi.fn()
    const cancel = vi.fn()
    const harness = startDesktopMultiplexSubscribe({
      attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
      settleRemoteTerminalSourceRanges: settle,
      reserveRemoteTerminalSourceRangeReplacement: vi.fn(() => null),
      commitRemoteTerminalSourceRangeReplacement: vi.fn(() => false),
      rollbackRemoteTerminalSourceRangeReplacement: vi.fn(() => false),
      cancelRemoteTerminalSourceRanges: cancel,
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(dataListener).not.toBeNull())
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed')
    const emitData = dataListener as unknown as (
      data: string,
      meta?: RuntimeTerminalDataMeta
    ) => void
    const acknowledge = (ackedEndByte: number): void => {
      harness.handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Ack,
            streamId: 7,
            seq: 2,
            payload: encodeTerminalStreamJson({
              streamGeneration: subscribed.streamGeneration,
              ackedEndByte
            })
          })
        )!
      )
    }
    harness.binaryFrames.splice(0)

    emitData('a'.repeat(100), {
      seq: 100,
      rawLength: 100,
      sourceRanges: [sourceRange(0, 100)]
    })
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.filter(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
        )
      ).toHaveLength(1)
    )
    acknowledge(40)
    expect(settle).not.toHaveBeenCalled()

    emitData('next', {
      seq: 104,
      rawLength: 4,
      sourceRanges: [
        {
          ...sourceRange(100, 104),
          clientGeneration: 3,
          ownerGeneration: 4,
          deliveryToken: 'token-2'
        }
      ]
    })
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.filter(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
        )
      ).toHaveLength(2)
    )
    expect(cancel).not.toHaveBeenCalled()
    expect(harness.handlers.has(7)).toBe(true)

    acknowledge(100)
    expect(settle).toHaveBeenLastCalledWith(expect.any(Object), [
      expect.objectContaining({ deliveryToken: 'token-1', sourceEndSu: 100 })
    ])
    acknowledge(104)
    expect(settle).toHaveBeenLastCalledWith(expect.any(Object), [
      expect.objectContaining({ deliveryToken: 'token-2', sourceStartSu: 100 })
    ])

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it.each(['refuses', 'throws'] as const)(
    'closes without reserving ACK debt when the transport %s an output frame',
    async (failureMode) => {
      let dataListener:
        | ((data: string, meta?: { seq?: number; rawLength?: number }) => void)
        | null = null
      let rejectOutput = false
      const unsubscribeData = vi.fn()
      const harness = startDesktopMultiplexSubscribe(
        {
          subscribeToTerminalData: vi.fn((_ptyId, listener) => {
            dataListener = listener
            return unsubscribeData
          })
        },
        undefined,
        (bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          if (!rejectOutput || frame?.opcode !== TerminalStreamOpcode.Output) {
            return true
          }
          if (failureMode === 'throws') {
            throw new Error('socket closed')
          }
          return false
        }
      )

      await vi.waitFor(() =>
        expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      sendDesktopMultiplexSubscribe(harness.handlers)
      await vi.waitFor(() =>
        expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(
          true
        )
      )
      await vi.waitFor(() => expect(dataListener).not.toBeNull())
      harness.binaryFrames.splice(0)
      rejectOutput = true

      const output = 'x'.repeat(64 * 1024)
      const deliverData = dataListener as unknown as (
        data: string,
        meta?: { seq?: number; rawLength?: number }
      ) => void
      deliverData(output, { seq: output.length, rawLength: output.length })

      await vi.waitFor(() => expect(unsubscribeData).toHaveBeenCalledOnce())
      await harness.dispatchPromise
      expect(
        harness.binaryFrames
          .map((bytes) => decodeTerminalStreamFrame(bytes))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      ).toEqual([])
      expect(harness.handlers.size).toBe(0)
    }
  )

  it('multiplexes terminal streams and routes desktop resize to the source PTY', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40
        }),
        serializeAuthoritativeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'authoritative snapshot',
          cols: 120,
          rows: 40
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn(
          (
            _: string,
            listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
          ) => {
            dataListenerRef.current = listener
            return vi.fn()
          }
        ),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-1',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      expect(handlers.has(0)).toBe(true)

      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 5,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 300, rows: 150 },
              capabilities: { desktopViewportClaims: 1 }
            })
          })
        )!
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      expect(messages.map((msg) => JSON.parse(msg).result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fit-override-changed',
            streamId: 5,
            mode: 'desktop-fit'
          }),
          expect.objectContaining({
            type: 'driver-changed',
            streamId: 5,
            driver: { kind: 'idle' }
          })
        ])
      )
      expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
        'pty-1',
        'multiplex:conn-1:5',
        'desktop-1',
        300,
        150,
        false
      )
      expect(handlers.has(5)).toBe(true)

      let releaseClaim = (): void => {}
      vi.mocked(runtime.updateRemoteDesktopViewer).mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseClaim = () => resolve(true)
          })
      )

      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.ClaimViewport,
            streamId: 5,
            seq: 0,
            payload: encodeTerminalStreamJson({ cols: 96, rows: 32 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          96,
          32,
          true
        )
      )
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 5,
            seq: 1,
            payload: encodeTerminalStreamJson({ cols: 96, rows: 32 })
          })
        )!
      )
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Input,
            streamId: 5,
            seq: 2,
            payload: encodeTerminalStreamText('ls\r')
          })
        )!
      )
      expect(runtime.sendTerminal).not.toHaveBeenCalled()
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenLastCalledWith(
        'pty-1',
        'multiplex:conn-1:5',
        'desktop-1',
        96,
        32,
        false
      )
      releaseClaim()
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          96,
          32,
          false
        )
      )
      await vi.waitFor(() =>
        expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
          text: 'ls\r',
          enter: false,
          interrupt: false
        })
      )
      const sentAfterSuccessfulClaim = vi.mocked(runtime.sendTerminal).mock.calls.length
      vi.mocked(runtime.updateRemoteDesktopViewer).mockResolvedValueOnce(false)
      for (const [opcode, seq, payload] of [
        [TerminalStreamOpcode.ClaimViewport, 3, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Resize, 4, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Input, 5, encodeTerminalStreamText('blocked')]
      ] as const) {
        handlers.get(5)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({ opcode, streamId: 5, seq, payload })
          )!
        )
      }
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          88,
          28,
          false
        )
      )
      expect(runtime.sendTerminal).toHaveBeenCalledTimes(sentAfterSuccessfulClaim)
      for (const [opcode, seq, payload] of [
        [TerminalStreamOpcode.ClaimViewport, 6, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Resize, 7, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Input, 8, encodeTerminalStreamText('retry')]
      ] as const) {
        handlers.get(5)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({ opcode, streamId: 5, seq, payload })
          )!
        )
      }
      await vi.waitFor(() =>
        expect(runtime.sendTerminal).toHaveBeenLastCalledWith('terminal-1', {
          text: 'retry',
          enter: false,
          interrupt: false
        })
      )

      dataListenerRef.current?.('a')
      dataListenerRef.current?.('b')
      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames).toHaveLength(1)
      expect(outputFrames[0]?.streamId).toBe(5)
      expect(outputFrames[0] ? decodeTerminalStreamText(outputFrames[0].payload) : '').toBe('ab')

      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 5,
            seq: 3,
            payload: encodeTerminalStreamJson({ cols: 100, rows: 30 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          100,
          30,
          false
        )
      )

      const snapshotStartFrame = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
      expect(
        snapshotStartFrame && decodeTerminalStreamJson(snapshotStartFrame.payload)
      ).toMatchObject({
        cols: 120,
        rows: 40
      })

      const frameCountBeforeSnapshotRequest = binaryFrames.length
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 5,
            seq: 4,
            payload: encodeTerminalStreamJson({
              requestId: 7,
              scrollbackRows: 5000
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          binaryFrames
            .slice(frameCountBeforeSnapshotRequest)
            .map((frame) => decodeTerminalStreamFrame(frame))
            .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
        ).toBe(true)
      )
      const requestedSnapshotFrames = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
      const requestedSnapshotStart = requestedSnapshotFrames.find(
        (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
      )
      expect(
        requestedSnapshotStart && decodeTerminalStreamJson(requestedSnapshotStart.payload)
      ).toMatchObject({
        requestId: 7
      })
      expect(runtime.serializeTerminalBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 0
      })
      expect(runtime.serializeAuthoritativeTerminalBuffer).toHaveBeenLastCalledWith('pty-1', {
        scrollbackRows: 5000
      })
      expect(
        requestedSnapshotFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('authoritative snapshot')

      // A viewport-less stream is passive: it must neither register nor later
      // release the active stream's width floor when the connection closes.
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 5,
            payload: encodeTerminalStreamJson({
              streamId: 6,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          messages.some(
            (msg) =>
              JSON.parse(msg).result?.type === 'subscribed' &&
              JSON.parse(msg).result?.streamId === 6
          )
        ).toBe(true)
      )

      // A second active floor on the same PTY is released in the same batch,
      // keeping connection teardown to one registry recomputation per PTY.
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 6,
            payload: encodeTerminalStreamJson({
              streamId: 7,
              terminal: 'terminal-1',
              client: { id: 'desktop-2', type: 'desktop' },
              viewport: { cols: 90, rows: 30 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          messages.some(
            (msg) =>
              JSON.parse(msg).result?.type === 'subscribed' &&
              JSON.parse(msg).result?.streamId === 7
          )
        ).toBe(true)
      )

      runtime.cleanupSubscription('terminal-multiplex:conn-1')
      await dispatchPromise
      expect(runtime.unregisterRemoteDesktopViewer).not.toHaveBeenCalled()
      expect(runtime.unregisterRemoteDesktopViewers).toHaveBeenCalledTimes(1)
      expect(runtime.unregisterRemoteDesktopViewers).toHaveBeenCalledWith('pty-1', [
        'multiplex:conn-1:5',
        'multiplex:conn-1:7'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a viewer resize parked during a snapshot-request buffering window', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-snap',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 9,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 300, rows: 150 },
              capabilities: { desktopViewportClaims: 1 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      // Ignore the subscribe-time floor registration; assert only the drained one.
      vi.mocked(runtime.updateRemoteDesktopViewer).mockClear()

      // A snapshot request opens the buffering window synchronously (buffering
      // is set before the first await inside the handler)...
      handlers.get(9)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 9,
            seq: 2,
            payload: encodeTerminalStreamJson({ requestId: 3, scrollbackRows: 1000 })
          })
        )!
      )
      // ...so a resize arriving now is PARKED, not applied inline.
      handlers.get(9)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 9,
            seq: 3,
            payload: encodeTerminalStreamJson({ cols: 88, rows: 33 })
          })
        )!
      )
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenCalled()

      // Once the snapshot completes and buffering clears, the parked resize is
      // drained (previously it was silently dropped until the next resize).
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
          'pty-1',
          'multiplex:conn-snap:9',
          'desktop-1',
          88,
          33,
          false
        )
      )

      runtime.cleanupSubscription('terminal-multiplex:conn-snap')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a resize drained after the initial snapshot', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let resolveSnapshot = (_value: { data: string; cols: number; rows: number }): void => {}
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq?: number
        }) => void)
      | undefined
    const updateRemoteDesktopViewer = vi.fn(
      async (_ptyId: string, _key: string, _clientId: string, cols: number, rows: number) => {
        if (updateRemoteDesktopViewer.mock.calls.length > 1) {
          resizeListener?.({ cols, rows, displayMode: 'desktop', reason: 'apply-layout', seq: 2 })
        }
        return true
      }
    )
    const runtime = stubRuntime({
      updateRemoteDesktopViewer,
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(
        () =>
          new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
            resolveSnapshot = resolve
          })
      ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_ptyId, listener) => {
        resizeListener = listener
        return vi.fn()
      }),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-initial-resize',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 9,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 80, rows: 24 }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
    handlers.get(9)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Resize,
          streamId: 9,
          seq: 2,
          payload: encodeTerminalStreamJson({ cols: 132, rows: 43 })
        })
      )!
    )
    expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(1)

    resolveSnapshot({ data: 'snapshot', cols: 80, rows: 24 })
    await vi.waitFor(() =>
      expect(
        binaryFrames.some(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Resized
        )
      ).toBe(true)
    )
    const opcodes = binaryFrames.map((bytes) => decodeTerminalStreamFrame(bytes)?.opcode)
    expect(opcodes.indexOf(TerminalStreamOpcode.Resized)).toBeGreaterThan(
      opcodes.indexOf(TerminalStreamOpcode.SnapshotEnd)
    )

    runtime.cleanupSubscription('terminal-multiplex:conn-initial-resize')
    await dispatchPromise
  })

  it('drops stale mobile resize re-stream completions for multiplex streams', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq: number
        }) => void)
      | undefined
    const restreamResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
    const write = vi.fn()
    const commit = vi.fn().mockResolvedValue(undefined)
    const beginMobileInputFloor = vi.fn(() => ({ commit, rollback: vi.fn() }))
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 80, rows: 24 })
        .mockImplementation(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              restreamResolves.push(resolve)
            })
        ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_, listener) => {
        resizeListener = listener as typeof resizeListener
        return vi.fn()
      }),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        options.reserveWrite('pty-1')
        write()
        await options.afterWrite('pty-1')
        return { accepted: true }
      }),
      beginMobileInputFloor,
      updateMobileViewport: vi.fn().mockResolvedValue({ updated: false, applied: false })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-stale-multiplex-resize',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 5,
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' }
          })
        })
      )!
    )

    await vi.waitFor(() => expect(resizeListener).toBeDefined())
    handlers.get(5)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Resize,
          streamId: 5,
          seq: 2,
          payload: encodeTerminalStreamJson({ cols: 90, rows: 24 })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.updateMobileViewport).toHaveBeenCalled())
    handlers.get(5)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 5,
          seq: 3,
          payload: encodeTerminalStreamText('x')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith(
        'terminal-1',
        { text: 'x', enter: false, interrupt: false },
        { reserveWrite: expect.any(Function), afterWrite: expect.any(Function) }
      )
    )
    expect(beginMobileInputFloor.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]!
    )
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!)
    binaryFrames.splice(0)

    resizeListener?.({
      cols: 90,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 2
    })
    resizeListener?.({
      cols: 100,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 3
    })
    await vi.waitFor(() => expect(restreamResolves).toHaveLength(2))

    restreamResolves[1]?.({ data: 'newer', cols: 100, rows: 24 })
    await vi.waitFor(() =>
      expect(
        binaryFrames.some((frame) => {
          const decoded = decodeTerminalStreamFrame(frame)
          return (
            decoded?.opcode === TerminalStreamOpcode.SnapshotChunk &&
            decodeTerminalStreamText(decoded.payload) === 'newer'
          )
        })
      ).toBe(true)
    )
    restreamResolves[0]?.({ data: 'older', cols: 90, rows: 24 })
    await Promise.resolve()
    await Promise.resolve()

    const snapshotData = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    expect(snapshotData).toEqual(['newer'])

    cleanups.get('terminal-multiplex:conn-stale-multiplex-resize')?.()
    await dispatchPromise
  })

  it('flushes multibyte live output when encoded bytes reach the batch budget', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn(
          (
            _: string,
            listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
          ) => {
            dataListenerRef.current = listener
            return vi.fn()
          }
        ),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-multibyte-output-batch',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 6,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      binaryFrames.splice(0)

      const multibyteOutput = '界'.repeat(22_000)
      const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode')
      dataListenerRef.current?.(multibyteOutput, {
        seq: multibyteOutput.length,
        rawLength: multibyteOutput.length
      })

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames.length).toBeGreaterThan(1)
      expect(outputFrames.every((frame) => (frame?.payload.byteLength ?? 0) <= 48 * 1024)).toBe(
        true
      )
      expect(outputFrames.map((frame) => frame?.seq)).toEqual([16_384, 22_000])
      expect(
        outputFrames.map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : '')).join('')
      ).toBe(multibyteOutput)
      expect(encodeSpy).not.toHaveBeenCalledWith(multibyteOutput)
      encodeSpy.mockRestore()

      cleanups.get('terminal-multiplex:conn-multibyte-output-batch')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds ACK-capable multiplex output over budget until the client acknowledges bytes', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const dataListenerRef: {
      current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    } = {}
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'snapshot',
        cols: 120,
        rows: 40
      }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn(
        (
          _: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListenerRef.current = listener
          return vi.fn()
        }
      ),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-ack-gated',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 16,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(700 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)
    expect(initialOutputFrames.length).toBeGreaterThan(0)
    const initialOutput = initialOutputFrames
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
    expect(initialOutput.length).toBeLessThan(output.length)

    handlers.get(16)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 16,
          seq: 2,
          payload: encodeTerminalStreamText('still interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'still interactive\r',
        enter: false,
        interrupt: false
      })
    )

    handlers.get(16)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 16,
          seq: 3,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )

    const flushedOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    expect(flushedOutputFrames.length).toBeGreaterThan(initialOutputFrames.length)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-gated')
    await dispatchPromise
  })

  it('round-robins released ACK budget to a later interactive stream', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const dataListeners = new Map<
      string,
      (data: string, meta?: { seq?: number; rawLength?: number }) => void
    >()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn((terminal: string) => ({
        ptyId: terminal.replace('terminal-', 'pty-')
      })),
      resolveLiveLeafForHandle: vi.fn((terminal: string) => ({
        ptyId: terminal.replace('terminal-', 'pty-')
      })),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(async (ptyId: string) => ({
        data: `snapshot-${ptyId}`,
        cols: 120,
        rows: 40
      })),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn(
        (
          ptyId: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListeners.set(ptyId, listener)
          return vi.fn()
        }
      ),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-ack-shared-budget',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )

    const streamIds = [21, 22, 23, 24, 25, 26, 27, 28]
    for (const streamId of streamIds) {
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: `terminal-${streamId - 20}`,
              client: { id: `desktop-${streamId}`, type: 'desktop' },
              viewport: { cols: 120, rows: 40 },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }

    await vi.waitFor(() =>
      expect(
        messages
          .map((msg) => JSON.parse(msg).result)
          .filter((result) => result?.type === 'subscribed')
      ).toHaveLength(streamIds.length)
    )
    await vi.waitFor(() => expect(dataListeners.size).toBe(streamIds.length))
    binaryFrames.splice(0)

    const fillerOutput = 'f'.repeat(512 * 1024)
    for (let index = 1; index <= 4; index += 1) {
      dataListeners.get(`pty-${index}`)?.(fillerOutput, {
        seq: fillerOutput.length,
        rawLength: fillerOutput.length
      })
    }
    const queuedFillerOutput = 'q'.repeat(256 * 1024)
    for (let index = 1; index <= 4; index += 1) {
      dataListeners.get(`pty-${index}`)?.(queuedFillerOutput, {
        seq: fillerOutput.length + queuedFillerOutput.length,
        rawLength: queuedFillerOutput.length
      })
    }
    const stalledOutput = 's'.repeat(256 * 1024)
    for (let index = 5; index <= 7; index += 1) {
      dataListeners.get(`pty-${index}`)?.(stalledOutput, {
        seq: stalledOutput.length,
        rawLength: stalledOutput.length
      })
    }
    const interactiveOutput = 'interactive-output\r\n'
    dataListeners.get('pty-8')?.(interactiveOutput, {
      seq: interactiveOutput.length,
      rawLength: interactiveOutput.length
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytesByStream = new Map<number, number>()
    for (const frame of initialOutputFrames) {
      if (!frame) {
        continue
      }
      initialBytesByStream.set(
        frame.streamId,
        (initialBytesByStream.get(frame.streamId) ?? 0) + frame.payload.byteLength
      )
    }
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(initialBytesByStream.get(21)).toBe(512 * 1024)
    expect(initialBytesByStream.get(22)).toBe(512 * 1024)
    expect(initialBytesByStream.get(23)).toBe(512 * 1024)
    expect(initialBytesByStream.get(24)).toBe(512 * 1024)
    expect(initialBytesByStream.get(25) ?? 0).toBe(0)
    expect(initialBytesByStream.get(26) ?? 0).toBe(0)
    expect(initialBytesByStream.get(27) ?? 0).toBe(0)
    expect(initialBytesByStream.get(28) ?? 0).toBe(0)

    handlers.get(28)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 28,
          seq: 200,
          payload: encodeTerminalStreamText('remote-still-interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-8', {
        text: 'remote-still-interactive\r',
        enter: false,
        interrupt: false
      })
    )

    const frameCountBeforeAck = binaryFrames.length
    handlers.get(21)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 21,
          seq: 201,
          payload: encodeTerminalStreamJson({ bytes: initialBytesByStream.get(21) ?? 0 })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .slice(frameCountBeforeAck)
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some(
            (frame) =>
              frame?.streamId === 28 &&
              frame.opcode === TerminalStreamOpcode.Output &&
              decodeTerminalStreamText(frame.payload) === interactiveOutput
          )
      ).toBe(true)
    )
    const framesAfterAck = binaryFrames
      .slice(frameCountBeforeAck)
      .map((frame) => decodeTerminalStreamFrame(frame))
    const outputFramesAfterAck = framesAfterAck.filter(
      (frame) => frame?.opcode === TerminalStreamOpcode.Output
    )
    const bytesAfterAckByStream = new Map<number, number>()
    for (const frame of outputFramesAfterAck) {
      if (!frame) {
        continue
      }
      bytesAfterAckByStream.set(
        frame.streamId,
        (bytesAfterAckByStream.get(frame.streamId) ?? 0) + frame.payload.byteLength
      )
    }
    expect(bytesAfterAckByStream.get(25) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(26) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(27) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(28) ?? 0).toBe(interactiveOutput.length)
    expect(bytesAfterAckByStream.get(21) ?? 0).toBeGreaterThan(0)
    expect(
      outputFramesAfterAck.reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    ).toBeLessThanOrEqual((initialBytesByStream.get(21) ?? 0) * 2)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-shared-budget')
    await dispatchPromise
  })

  it('replaces UTF-8-expanded overflow ranges before publishing the trailing live range', async () => {
    let resolveRecovery: (snapshot: OverflowRecoverySnapshot) => void = () => {}
    const harness = startSourceRangeOverflowHarness({
      recover: () =>
        new Promise<OverflowRecoverySnapshot>((resolve) => {
          resolveRecovery = resolve
        })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    const flooded = '界'.repeat(1024 * 1024)
    const credit = await acknowledgeSourceRangeOverflow(
      harness,
      harness.getDataListener()!,
      flooded,
      'first'
    )
    await vi.waitFor(() => expect(harness.runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
    const trailing = 'trailing-live'
    harness.getDataListener()!(trailing, {
      seq: flooded.length + trailing.length,
      rawLength: trailing.length,
      sourceRanges: [sourceRange(flooded.length, flooded.length + trailing.length)]
    })
    resolveRecovery({
      data: 'authoritative snapshot',
      cols: 120,
      rows: 40,
      source: 'headless',
      seq: flooded.length
    })

    await vi.waitFor(() => expect(harness.commit).toHaveBeenCalledOnce())
    expect(harness.reserve).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamGeneration: expect.any(String) }),
      flooded.length,
      'ack-pending-overflow'
    )
    expect(harness.lifecycle).toEqual(['reserve', 'commit'])
    const recoveryFrames = harness.binaryFrames.map(decodeTerminalStreamFrame)
    const snapshotEnd = recoveryFrames.findLastIndex(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd
    )
    const trailingOutput = recoveryFrames.findIndex(
      (frame, index) =>
        index > snapshotEnd &&
        frame?.opcode === TerminalStreamOpcode.Output &&
        decodeTerminalStreamText(frame.payload) === trailing
    )
    expect(snapshotEnd).toBeGreaterThanOrEqual(0)
    expect(trailingOutput).toBeGreaterThan(snapshotEnd)
    expect(harness.rollback).not.toHaveBeenCalled()
    const trailingBytes = recoveryFrames[trailingOutput]!.payload.byteLength
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 7,
          seq: 3,
          payload: encodeTerminalStreamJson({
            streamGeneration: credit.streamGeneration,
            ackedEndByte: credit.acceptedEndByte + trailingBytes
          })
        })
      )!
    )
    expect(harness.runtime.settleRemoteTerminalSourceRanges).toHaveBeenLastCalledWith(
      expect.any(Object),
      [sourceRange(flooded.length, flooded.length + trailing.length)]
    )

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('rolls back overflow replacement before detaching on partial frame publication', async () => {
    let recoveryStarted = false
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: 3 * 1024 * 1024
      }),
      onFrame: (frame) => {
        if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
          recoveryStarted =
            decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason ===
            'ack-pending-overflow'
        }
        if (recoveryStarted && frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
          return false
        }
        return undefined
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    const flooded = 'x'.repeat(3 * 1024 * 1024)
    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await harness.dispatchPromise

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'rollback', 'cancel'])
  })

  it('rolls back overflow replacement before generic detach when commit rejects', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'renderer',
        seq: flooded.length
      }),
      commit: () => false
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce())

    expect(harness.commit).toHaveBeenCalledOnce()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'commit', 'rollback', 'cancel'])
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('rolls back a held overflow replacement when its stream detaches', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    let harness: ReturnType<typeof startSourceRangeOverflowHarness>
    harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: flooded.length
      }),
      onFrame: (frame) => {
        if (
          frame.opcode !== TerminalStreamOpcode.SnapshotStart ||
          decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason !==
            'ack-pending-overflow'
        ) {
          return
        }
        harness.handlers.get(7)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Unsubscribe,
              streamId: 7,
              seq: 3,
              payload: new Uint8Array()
            })
          )!
        )
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.handlers.has(7)).toBe(false))

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'rollback', 'cancel'])
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('rolls back overflow replacement before a same-slot generation succeeds it', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    let harness: ReturnType<typeof startSourceRangeOverflowHarness>
    harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: flooded.length
      }),
      onFrame: (frame) => {
        if (
          frame.opcode !== TerminalStreamOpcode.SnapshotStart ||
          decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason !==
            'ack-pending-overflow'
        ) {
          return
        }
        harness.handlers.get(0)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Subscribe,
              streamId: 0,
              seq: 3,
              payload: encodeTerminalStreamJson({
                streamId: 7,
                terminal: 'terminal-1',
                client: { id: 'desktop-2', type: 'desktop' },
                capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
              })
            })
          )!
        )
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
          .length
      ).toBe(2)
    )

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle.slice(0, 3)).toEqual(['reserve', 'rollback', 'cancel'])
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('does not publish or trim overflow output without serialized source identity', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'unattributed snapshot',
        cols: 120,
        rows: 40,
        seq: flooded.length
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())
    const frameCount = harness.binaryFrames.length

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce())

    expect(harness.reserve.mock.calls.some((call) => call[2] === 'ack-pending-overflow')).toBe(
      false
    )
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).not.toHaveBeenCalled()
    expect(
      harness.binaryFrames
        .slice(frameCount)
        .map(decodeTerminalStreamFrame)
        .some(
          (frame) =>
            frame?.opcode === TerminalStreamOpcode.SnapshotStart &&
            decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason ===
              'ack-pending-overflow'
        )
    ).toBe(false)
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('caps stalled ACK output and snapshots before resuming retained tail frames', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const dataListenerRef: {
      current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    } = {}
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
        .mockResolvedValue({ data: 'recovered snapshot', cols: 120, rows: 40, seq: 99 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn(
        (
          _: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListenerRef.current = listener
          return vi.fn()
        }
      ),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-ack-overflow',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 17,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(3 * 1024 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)

    handlers.get(17)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 17,
          seq: 2,
          payload: encodeTerminalStreamText('still interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'still interactive\r',
        enter: false,
        interrupt: false
      })
    )

    binaryFrames.splice(0)
    handlers.get(17)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 17,
          seq: 3,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some((frame) => {
            if (frame?.opcode !== TerminalStreamOpcode.SnapshotStart) {
              return false
            }
            const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
            return payload?.reason === 'ack-pending-overflow'
          })
      ).toBe(true)
    )
    const drainFrames = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    const recoveryStartIndex = drainFrames.findIndex((frame) => {
      if (frame?.opcode !== TerminalStreamOpcode.SnapshotStart) {
        return false
      }
      const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
      return payload?.reason === 'ack-pending-overflow'
    })
    const firstOutputAfterAckIndex = drainFrames.findIndex(
      (frame) => frame?.opcode === TerminalStreamOpcode.Output
    )
    expect(recoveryStartIndex).toBeGreaterThanOrEqual(0)
    // Why: clients discard truncated snapshots; a usable recovery snapshot
    // must not be marked truncated or the dropped output gap is permanent.
    expect(
      decodeTerminalStreamJson<{ truncated?: boolean }>(drainFrames[recoveryStartIndex]!.payload)
        ?.truncated
    ).toBe(false)
    expect(firstOutputAfterAckIndex).toBeGreaterThan(recoveryStartIndex)
    expect(
      drainFrames
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('recovered snapshot')

    const outputBytesAfterRecovery = drainFrames
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    expect(outputBytesAfterRecovery).toBeLessThanOrEqual(256 * 1024)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-overflow')
    await dispatchPromise
  })

  it.each([
    {
      failure: 'throws',
      recover: () => Promise.reject(new Error('snapshot unavailable'))
    },
    {
      failure: 'returns no snapshot',
      recover: () => Promise.resolve(null)
    }
  ])('ends a stream when ACK overflow recovery serialization $failure', async ({ recover }) => {
    const dataListenerRef: {
      current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    } = {}
    const serializeTerminalBuffer = vi
      .fn()
      .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
      .mockImplementation(recover)
    const harness = startDesktopMultiplexSubscribe({
      serializeTerminalBuffer,
      subscribeToTerminalData: vi.fn(
        (
          _: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListenerRef.current = listener
          return vi.fn()
        }
      )
    })

    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    harness.binaryFrames.splice(0)

    const output = 'x'.repeat(3 * 1024 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })
    const inFlightBytes = harness.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamJson({ bytes: inFlightBytes })
        })
      )!
    )

    await vi.waitFor(() => {
      const eventTypes = harness.messages.map((message) => JSON.parse(message).result?.type)
      expect(eventTypes).toContain('error')
      expect(eventTypes).toContain('end')
    })
    expect(harness.handlers.has(7)).toBe(false)
    expect(serializeTerminalBuffer).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(serializeTerminalBuffer).toHaveBeenCalledTimes(2)

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('trims recovery-covered ACK pending output instead of replaying it', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const dataListenerRef: {
      current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    } = {}
    const floodedChars = 3 * 1024 * 1024
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
        // Why: the recovery snapshot seq covers the entire flood, so every
        // retained pending chunk is already contained in the snapshot.
        .mockResolvedValue({ data: 'recovered snapshot', cols: 120, rows: 40, seq: floodedChars }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn(
        (
          _: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListenerRef.current = listener
          return vi.fn()
        }
      ),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-ack-trim',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 31,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(floodedChars)
    dataListenerRef.current?.(output, { seq: floodedChars, rawLength: floodedChars })
    const initialBytes = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)

    binaryFrames.splice(0)
    handlers.get(31)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 31,
          seq: 2,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
      ).toBe(true)
    )

    const framesAfterRecovery = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    expect(
      framesAfterRecovery
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('recovered snapshot')
    // Why: every retained chunk is covered by the recovery snapshot seq;
    // replaying any of them would duplicate snapshot content.
    expect(
      framesAfterRecovery.filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    ).toEqual([])

    binaryFrames.splice(0)
    const fresh = 'fresh-after-recovery\r\n'
    dataListenerRef.current?.(fresh, {
      seq: floodedChars + fresh.length,
      rawLength: fresh.length
    })
    await vi.waitFor(() => {
      const freshOutput = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(freshOutput).toBe(fresh)
    })

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-trim')
    await dispatchPromise
  })

  it('keeps a limited retained-tail fallback usable for multiplex first paint', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({
        tail: ['line 120'],
        truncated: false,
        limited: true
      }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-multiplex-limited',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 11,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const subscribed = messages
      .map((msg) => JSON.parse(msg).result)
      .find((result) => result?.type === 'subscribed')
    expect(subscribed).toMatchObject({
      type: 'subscribed',
      streamId: 11,
      truncated: false
    })

    const decodedFrames = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    const snapshotStart = decodedFrames.find(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart && frame.streamId === 11
    )
    expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
      truncated: false
    })
    const snapshotData = decodedFrames
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
    expect(snapshotData).toBe('line 120\r\n')

    runtime.cleanupSubscription('terminal-multiplex:conn-multiplex-limited')
    await dispatchPromise
  })

  it('does not mark a serialized multiplex snapshot truncated from an overflowed read', async () => {
    const harness = startDesktopMultiplexSubscribe({
      readTerminal: vi.fn().mockResolvedValue({
        tail: ['old retained line'],
        truncated: true,
        limited: true
      }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'authoritative current screen\r\n',
        cols: 120,
        rows: 40
      })
    })

    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )

    const snapshotStart = harness.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart && frame.streamId === 7)
    expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
      truncated: false
    })
    expect(
      harness.binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('authoritative current screen\r\n')

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('falls back to smaller requested snapshots when serialized data exceeds the send budget', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 120, rows: 40 })
        .mockResolvedValueOnce({
          data: 'x'.repeat(2 * 1024 * 1024 + 1),
          cols: 120,
          rows: 40
        })
        .mockResolvedValueOnce({
          data: 'budgeted snapshot',
          cols: 120,
          rows: 40
        }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-budgeted-request',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 14,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const frameCountBeforeSnapshotRequest = binaryFrames.length

    handlers.get(14)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotRequest,
          streamId: 14,
          seq: 2,
          payload: encodeTerminalStreamJson({
            requestId: 55,
            scrollbackRows: 5000
          })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(3))

    const requestedFrames = binaryFrames
      .slice(frameCountBeforeSnapshotRequest)
      .map((frame) => decodeTerminalStreamFrame(frame))
    const requestedStart = requestedFrames.find(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
    )
    expect(requestedStart && decodeTerminalStreamJson(requestedStart.payload)).toMatchObject({
      requestId: 55,
      truncatedByByteBudget: true
    })
    expect(runtime.serializeTerminalBuffer).toHaveBeenNthCalledWith(2, 'pty-1', {
      scrollbackRows: 5000
    })
    expect(runtime.serializeTerminalBuffer).toHaveBeenNthCalledWith(3, 'pty-1', {
      scrollbackRows: 1000
    })
    expect(
      requestedFrames
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('budgeted snapshot')

    cleanups.get('terminal-multiplex:conn-budgeted-request')?.()
    await dispatchPromise
  })

  it('drops desktop multiplex input while a mobile client owns the terminal floor', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue({
        mode: 'mobile-fit',
        cols: 49,
        rows: 20
      }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'phone-1' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-locked',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(handlers.has(7)).toBe(true))
    await vi.waitFor(() =>
      expect(messages.map((msg) => JSON.parse(msg).result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fit-override-changed',
            streamId: 7,
            mode: 'mobile-fit',
            cols: 49,
            rows: 20
          }),
          expect.objectContaining({
            type: 'driver-changed',
            streamId: 7,
            driver: { kind: 'mobile', clientId: 'phone-1' }
          })
        ])
      )
    )

    handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('typed while locked')
        })
      )!
    )

    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    cleanups.get('terminal-multiplex:conn-locked')?.()
    await dispatchPromise
  })

  it('preserves LF input frames before writing to the multiplexed PTY', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-byte-preserving',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 9,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(handlers.has(9)).toBe(true))

    handlers.get(9)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 9,
          seq: 2,
          payload: encodeTerminalStreamText('echo one\necho two\r\n')
        })
      )!
    )

    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'echo one\necho two\r\n',
        enter: false,
        interrupt: false
      })
    )

    runtime.cleanupSubscription('terminal-multiplex:conn-byte-preserving')
    await dispatchPromise
  })

  it('preserves LF input frames before writing to the subscribed PTY', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-subscribe-byte-preserving',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const streamId = JSON.parse(
      messages.find((msg) => JSON.parse(msg).result?.type === 'subscribed')!
    ).result.streamId as number
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId,
          seq: 1,
          payload: encodeTerminalStreamText('printf a\nprintf b\r\n')
        })
      )!
    )

    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'printf a\nprintf b\r\n',
        enter: false,
        interrupt: false
      })
    )

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('owns and releases a viewport floor for legacy JSON desktop streams', async () => {
    const messages: string[] = []
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-json-1', type: 'desktop' },
        viewport: { cols: 88, rows: 30 }
      }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-json-1' }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'scrollback')).toBe(true)
    )
    const subscriptionKey = vi.mocked(runtime.updateRemoteDesktopViewer).mock.calls[0]?.[1]
    expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
      'pty-1',
      expect.stringMatching(/^json:/),
      'desktop-json-1',
      88,
      30,
      true
    )

    runtime.cleanupSubscription('terminal-1:desktop-json-1')
    await dispatchPromise
    expect(runtime.unregisterRemoteDesktopViewer).toHaveBeenCalledWith('pty-1', subscriptionKey)
  })

  it('bounds oversized live output frames for subscribed binary streams', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-subscribe-output-chunking',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      binaryFrames.splice(0)

      const output = 'output-line\n'.repeat(8_000)
      dataListenerRef.current?.(output)

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames.length).toBeGreaterThan(1)
      expect(outputFrames.every((frame) => (frame?.payload.byteLength ?? 0) <= 48 * 1024)).toBe(
        true
      )
      expect(
        outputFrames.map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : '')).join('')
      ).toBe(output)

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes output buffered during initial multiplex snapshot once', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: { data: string; cols: number; rows: number }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-on-subscribe',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      dataListenerRef.current?.('starting shell\r\n', {
        seq: 16,
        rawLength: 16
      })
      resolveSnapshot({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output).toBe('starting shell\r\n')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops buffered multiplex output already covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: {
        data: string
        cols: number
        rows: number
        seq: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const startupLine = 'starting shell\r\n'
      dataListenerRef.current?.(startupLine, {
        seq: startupLine.length,
        rawLength: startupLine.length
      })
      resolveSnapshot({
        data: startupLine,
        cols: 120,
        rows: 40,
        seq: startupLine.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      const snapshotStart = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
      expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
        seq: startupLine.length
      })
      expect(outputFrames).toHaveLength(0)

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays only buffered multiplex output not covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: {
        data: string
        cols: number
        rows: number
        seq: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-partially-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const buffered = 'hello world'
      dataListenerRef.current?.(buffered, {
        seq: buffered.length,
        rawLength: buffered.length
      })
      resolveSnapshot({
        data: 'hello',
        cols: 120,
        rows: 40,
        seq: 'hello'.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output).toBe(' world')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles mobile multiplex PTY waits when the stream signal aborts before PTY spawn', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const controller = new AbortController()
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn(
        (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      ),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        signal: controller.signal,
        connectionId: 'conn-phone-multiplex',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' }
          })
        })
      )!
    )

    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    const pendingWaitSignal = vi.mocked(runtime.waitForLeafPtyId).mock.calls[0]?.[2]
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith(
      'terminal-1',
      10_000,
      expect.any(AbortSignal)
    )

    controller.abort()
    await vi.waitFor(() => expect(pendingWaitSignal?.aborted).toBe(true))

    expect(runtime.readTerminal).not.toHaveBeenCalled()
    expect(
      messages.map((msg) => JSON.parse(msg).result).filter((result) => result?.streamId === 7)
    ).toEqual([])
    expect(binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)).not.toContain(
      TerminalStreamOpcode.Error
    )

    cleanups.get('terminal-multiplex:conn-phone-multiplex')?.()
    await dispatchPromise
  })

  it("waits for a desktop multiplex subscriber's PTY before retiring the terminal", async () => {
    let resolvePty: (ptyId: string) => void = () => {}
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvePty = resolve
          })
      )
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(
      harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    ).toEqual([])
    resolvePty('pty-1')
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
      ).toContain(TerminalStreamOpcode.SnapshotChunk)
    )
    expect(
      harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    ).toEqual([])
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('cancels a pending desktop PTY wait when its multiplex slot unsubscribes', async () => {
    let resolvePty: (ptyId: string) => void = () => {}
    let waitSignal: AbortSignal | undefined
    const readTerminal = vi.fn().mockResolvedValue({ tail: [], truncated: false })
    const subscribeToTerminalData = vi.fn().mockReturnValue(vi.fn())
    const registerRemoteTerminalViewSubscriber = vi.fn().mockReturnValue(vi.fn())
    const waitForLeafPtyId = vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          resolvePty = resolve
          waitSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId,
      readTerminal,
      subscribeToTerminalData,
      registerRemoteTerminalViewSubscriber
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitForLeafPtyId).toHaveBeenCalled())

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    resolvePty('pty-1')

    await vi.waitFor(() =>
      expect(waitSignal?.aborted || readTerminal.mock.calls.length > 0).toBe(true)
    )
    // Why: a closed pane must not become a hidden live-output consumer when its late PTY appears.
    expect(waitSignal?.aborted).toBe(true)
    expect(readTerminal).not.toHaveBeenCalled()
    expect(subscribeToTerminalData).not.toHaveBeenCalled()
    expect(registerRemoteTerminalViewSubscriber).not.toHaveBeenCalled()
    expect(harness.handlers.has(7)).toBe(false)

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('cancels an older pending PTY wait when the same multiplex slot resubscribes', async () => {
    const waitSignals: AbortSignal[] = []
    const waitForLeafPtyId = vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal) {
            waitSignals.push(signal)
          }
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )

    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitSignals).toHaveLength(1))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitSignals).toHaveLength(2))

    expect(waitSignals[0]?.aborted).toBe(true)
    expect(waitSignals[1]?.aborted).toBe(false)
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await vi.waitFor(() => expect(waitSignals[1]?.aborted).toBe(true))
    await harness.dispatchPromise
  })

  it('admits 128 active streams, rejects the 129th, and reuses released capacity', async () => {
    let dataSubscriberCount = 0
    let viewSubscriberCount = 0
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn(() => {
        dataSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            dataSubscriberCount -= 1
          }
        }
      }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      })
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }
    expect(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION).toBe(128)
    for (
      let streamId = 1;
      streamId <= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1;
      streamId += 1
    ) {
      sendSubscribe(streamId)
    }

    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      const subscribedStreamIds = results
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toHaveLength(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
      expect(subscribedStreamIds).toContain(44)
      expect(results).toContainEqual({
        type: 'error',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1,
        message: 'terminal_stream_limit_exceeded'
      })
      expect(results).toContainEqual({
        type: 'end',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
      })
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 1,
          seq: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 2,
          payload: new Uint8Array()
        })
      )!
    )
    await vi.waitFor(() => {
      expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(harness.handlers.has(1)).toBe(false)
    })

    const retriedStreamId = TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
    sendSubscribe(retriedStreamId)
    await vi.waitFor(() => {
      const subscribedStreamIds = harness.messages
        .map((message) => JSON.parse(message).result)
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toContain(retriedStreamId)
      expect(
        harness.binaryFrames.some((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return (
            frame?.streamId === retriedStreamId && frame.opcode === TerminalStreamOpcode.SnapshotEnd
          )
        })
      ).toBe(true)
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
    expect(dataSubscriberCount).toBe(0)
    expect(viewSubscriberCount).toBe(0)
  })

  it('reserves PTY wait capacity independently from active streams', async () => {
    const activeStreamCount = 44
    const waitSignals: AbortSignal[] = []
    const resolveWaits: ((ptyId: string) => void)[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn((terminal: string) =>
        terminal.startsWith('pending-') ? { ptyId: null } : { ptyId: `pty-${terminal}` }
      ),
      waitForLeafPtyId: vi.fn(
        (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            if (signal) {
              waitSignals.push(signal)
            }
            resolveWaits.push(resolve)
            signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      )
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number, terminal: string): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal,
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }

    for (let streamId = 1; streamId <= activeStreamCount; streamId += 1) {
      sendSubscribe(streamId, `active-${streamId}`)
    }
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(activeStreamCount)
    )

    for (
      let offset = 1;
      offset <= TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1;
      offset += 1
    ) {
      sendSubscribe(activeStreamCount + offset, `pending-${offset}`)
    }
    await vi.waitFor(() =>
      expect(waitSignals).toHaveLength(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION)
    )
    const rejectedStreamId =
      activeStreamCount + TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1
    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      expect(results).toContainEqual({
        type: 'error',
        streamId: rejectedStreamId,
        message: 'terminal_stream_limit_exceeded'
      })
      expect(results).toContainEqual({ type: 'end', streamId: rejectedStreamId })
    })

    for (const [index, resolve] of resolveWaits.entries()) {
      resolve(`pty-pending-${index + 1}`)
    }
    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      expect(results.filter((result) => result?.type === 'subscribed')).toHaveLength(
        activeStreamCount + TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
      )
      expect(
        results.filter(
          (result) =>
            result?.type === 'error' && result.message === 'terminal_stream_limit_exceeded'
        )
      ).toHaveLength(1)
    })

    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it("still reports no_connected_pty when a desktop multiplex subscriber's PTY never appears", async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('timeout'))
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
      ).toContain(TerminalStreamOpcode.Error)
    )
    const errorFrame = harness.binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('no_connected_pty')
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('emits initial desktop fit events after the first multiplex snapshot', async () => {
    const trace: string[] = []
    let fitListener: ((event: { mode: string; cols: number; rows: number }) => void) | undefined
    let driverListener: ((driver: unknown) => void) | undefined
    const harness = startDesktopMultiplexSubscribe(
      {
        readTerminal: vi.fn(async () => {
          fitListener?.({ mode: 'desktop-fit', cols: 100, rows: 30 })
          driverListener?.({ kind: 'transition-during-snapshot' })
          return { tail: [], truncated: false } as unknown as Awaited<
            ReturnType<OrcaRuntimeService['readTerminal']>
          >
        }),
        subscribeToFitOverrideChanges: vi.fn((_ptyId, listener) => {
          fitListener = listener
          return vi.fn()
        }),
        subscribeToDriverChanges: vi.fn((_ptyId, listener) => {
          driverListener = listener
          return vi.fn()
        })
      },
      trace
    )
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(trace).toContain('driver-changed'))
    expect(trace.lastIndexOf('snapshot')).toBeLessThan(trace.indexOf('fit-override-changed'))
    expect(trace.lastIndexOf('snapshot')).toBeLessThan(trace.indexOf('driver-changed'))
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('does not wait when a desktop multiplex subscriber already has a PTY', async () => {
    const runtime = stubRuntime({
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn()
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(
        true
      )
    )
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    harness.cleanups.get('terminal-multiplex:conn-desktop-first-paint')?.()
    await harness.dispatchPromise
  })

  it('preserves clientless multiplex subscriptions without a PTY wait', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    let cleanup: () => void = () => {}
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn(),
      registerSubscriptionCleanup: vi.fn((_id: string, callback: () => void) => {
        cleanup = callback
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-clientless-multiplex',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({ streamId: 7, terminal: 'terminal-1' })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)).toContain(
        TerminalStreamOpcode.Error
      )
    )
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    const errorFrame = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('no_connected_pty')
    cleanup()
    await dispatchPromise
  })

  it('preserves clientless legacy subscriptions without a PTY wait or mount', async () => {
    const messages: string[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn(),
      requestRendererTerminalTabMount: vi.fn(),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', { terminal: 'terminal-1' }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-clientless-legacy' }
    )
    await dispatchPromise
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(messages.map((msg) => JSON.parse(msg).result?.type)).toEqual(['subscribed', 'end'])
  })

  it('waits for a desktop legacy subscriber PTY before the scrollback-only fallback', async () => {
    const messages: string[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('timeout')),
      requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' }
      }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-desktop-legacy' }
    )
    await dispatchPromise
    // Widened gate: a desktop client must mount + await its late PTY, not skip
    // straight to the bare scrollback path the way it did under the mobile-only gate.
    expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith('terminal-1', 10_000, undefined)
    expect(messages.map((msg) => JSON.parse(msg).result?.type)).toEqual(['subscribed', 'end'])
  })

  it('keeps view-subscriber releases balanced when a same-streamId subscribe overwrites a blocked one', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    // Why: a leaked registration permanently suppresses the model query
    // responder (terminal-query-authority.md) — the count must return to 0.
    let viewSubscriberCount = 0
    let leafResolved = false
    let resolveFirstWait: (ptyId: string) => void = () => {}
    // Why: the multiplex subscribe path resolves via resolveLiveLeafForHandle
    // (#7718); null makes subscribe A block in waitForLeafPtyId until B resolves.
    const resolveLeaf = (): { ptyId: string | null } =>
      leafResolved ? { ptyId: 'pty-1' } : { ptyId: null }
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn(resolveLeaf),
      resolveLiveLeafForHandle: vi.fn(resolveLeaf),
      waitForLeafPtyId: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirstWait = resolve
          })
      ),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snap', cols: 80, rows: 24 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-overwrite',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    const sendSubscribe = (): void => {
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 7,
              terminal: 'terminal-1',
              client: { id: 'phone-1', type: 'mobile' }
            })
          })
        )!
      )
    }

    // Subscribe A blocks in waitForLeafPtyId; subscribe B (same streamId)
    // then resolves the leaf directly and fully registers.
    sendSubscribe()
    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    leafResolved = true
    sendSubscribe()
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        1
      )
    )

    // A resumes and takes the slot; B's registration must be released, not
    // orphaned by the overwrite.
    resolveFirstWait('pty-1')
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        2
      )
    )

    handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    expect(viewSubscriberCount).toBe(0)

    cleanups.get('terminal-multiplex:conn-overwrite')?.()
    await dispatchPromise
  })

  it('keeps an evicted subscribe error from detaching the successor stream', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let viewSubscriberCount = 0
    const mobileSubscribeWaiters: {
      resolve: () => void
      reject: (error: Error) => void
    }[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      // Why: the multiplex subscribe path resolves the leaf via
      // resolveLiveLeafForHandle (#7718), so it must return a live pty here.
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snap', cols: 80, rows: 24 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      handleMobileSubscribe: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            mobileSubscribeWaiters.push({ resolve: () => resolve(true), reject })
          })
      ),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-evicted-error',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    const sendSubscribe = (): void => {
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 9,
              terminal: 'terminal-1',
              client: { id: 'phone-1', type: 'mobile' }
            })
          })
        )!
      )
    }

    // A registers, then blocks in handleMobileSubscribe. B (same streamId)
    // evicts A on arrival and completes its own registration.
    sendSubscribe()
    await vi.waitFor(() => expect(mobileSubscribeWaiters).toHaveLength(1))
    sendSubscribe()
    await vi.waitFor(() => expect(mobileSubscribeWaiters).toHaveLength(2))
    mobileSubscribeWaiters[1]!.resolve()
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        1
      )
    )
    expect(viewSubscriberCount).toBe(1)

    // A's pending await now rejects. The evicted stream must not detach the
    // successor that owns the slot.
    mobileSubscribeWaiters[0]!.reject(new Error('mobile_subscribe_failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(viewSubscriberCount).toBe(1)

    cleanups.get('terminal-multiplex:conn-evicted-error')?.()
    await dispatchPromise
    expect(viewSubscriberCount).toBe(0)
  })

  it('rejects a stale terminal handle with terminal_handle_stale instead of binding the wrong PTY', async () => {
    // Why: after a reconnect a client can resubscribe with a handle whose
    // pane now hosts a different PTY. Binding the stream anyway would mirror
    // (and type into) the wrong terminal (#7718); the client recovers from
    // terminal_handle_stale by re-deriving the handle from the next snapshot.
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(() => {
        throw new Error('terminal_handle_stale')
      }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-stale-handle',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 9,
            terminal: 'stale-terminal',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        messages
          .map((msg) => JSON.parse(msg).result)
          .some((result) => result?.type === 'end' && result.streamId === 9)
      ).toBe(true)
    )
    const errorFrame = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('terminal_handle_stale')
    // The stream must never have bound to any PTY.
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()

    cleanups.get('terminal-multiplex:conn-stale-handle')?.()
    await dispatchPromise
  })

  it('bounds live output queued while a multiplex snapshot is loading', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const snapshotResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              snapshotResolves.push(resolve)
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 9,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())

      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(`${String(index).padStart(3, '0')}${'x'.repeat(1021)}`)
      }
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
      snapshotResolves.shift()?.({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      snapshotResolves.shift()?.({ data: '399', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output.length).toBeLessThanOrEqual(256 * 1024)
      expect(output).toBe('')
      const snapshotPayload = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(snapshotPayload).toBe('399')
      expect(output).not.toContain('000')

      cleanups.get('terminal-multiplex:conn-buffered')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds multibyte live output by encoded bytes while a multiplex snapshot is loading', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const snapshotResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              snapshotResolves.push(resolve)
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-multibyte',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 10,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())

      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(`${String(index).padStart(3, '0')}${'界'.repeat(341)}`)
      }
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
      snapshotResolves.shift()?.({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      snapshotResolves.shift()?.({ data: '399', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(256 * 1024)
      expect(output).toBe('')
      const snapshotPayload = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(snapshotPayload).toBe('399')
      expect(output).not.toContain('000')

      cleanups.get('terminal-multiplex:conn-buffered-multibyte')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries requested snapshots after live output overflows during serialization', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      let resolveRequestedSnapshot: (value: {
        data: string
        cols: number
        rows: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValueOnce({ data: 'initial', cols: 120, rows: 40 })
          .mockImplementationOnce(
            () =>
              new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
                resolveRequestedSnapshot = resolve
              })
          )
          .mockResolvedValueOnce({
            data: 'retry snapshot',
            cols: 120,
            rows: 40
          }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-request-overflow',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 12,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      const frameCountBeforeSnapshotRequest = binaryFrames.length

      handlers.get(12)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 12,
            seq: 2,
            payload: encodeTerminalStreamJson({
              requestId: 44,
              scrollbackRows: 5000
            })
          })
        )!
      )
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(String(index).padStart(3, '0') + 'x'.repeat(1021))
      }
      resolveRequestedSnapshot({ data: 'requested', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(3))
      await vi.waitFor(() =>
        expect(
          binaryFrames
            .slice(frameCountBeforeSnapshotRequest)
            .map((frame) => decodeTerminalStreamFrame(frame))
            .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
        ).toBe(true)
      )

      const requestedFrames = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
      const requestedStart = requestedFrames.find(
        (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
      )
      expect(requestedStart && decodeTerminalStreamJson(requestedStart.payload)).toMatchObject({
        requestId: 44,
        truncated: false
      })
      expect(
        requestedFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('retry snapshot')
      expect(
        requestedFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('')

      dataListenerRef.current?.('live-after-overflow')
      await vi.runOnlyPendingTimersAsync()
      const outputAfterOverflow = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(outputAfterOverflow).toBe('live-after-overflow')

      cleanups.get('terminal-multiplex:conn-request-overflow')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
