import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import { SshPtyOutputIntake, type SshPtyOutputDataEvent } from '../../ipc/ssh-pty-output-intake'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'
import {
  sendDesktopSourceRangeSubscribe,
  sourceRange
} from './terminal-multiplex-source-range-fixtures'

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
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
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

      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
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
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
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

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
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
})
