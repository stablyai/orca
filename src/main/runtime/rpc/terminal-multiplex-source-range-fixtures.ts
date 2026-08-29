import { expect, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { startDesktopMultiplexSubscribe } from './terminal-multiplex-test-harness'

export function sendDesktopSourceRangeSubscribe(
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

export function sourceRange(start: number, end: number) {
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

export async function acknowledgeSourceRangeOverflow(
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

export type OverflowRecoverySnapshot = {
  data: string
  cols: number
  rows: number
  source?: 'headless' | 'renderer'
  seq?: number
}

export function startSourceRangeOverflowHarness(options: {
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
