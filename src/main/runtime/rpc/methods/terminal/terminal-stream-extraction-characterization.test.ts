import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import './terminal-snapshot-publication'
import { publishMultiplexInitialSnapshot } from './terminal-multiplex-initial-snapshot'

import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import { EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE } from '../../../../../shared/terminal/protocol/queries/terminal-reply-query-scan'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'

// These assertions protect the permanent binary publication seam while its state machine
// lives in concrete terminal domain modules.
describe('terminal stream extraction characterization', () => {
  it('publishes the latest nonempty initial image when startup output overflows twice', async () => {
    const frames: { opcode: TerminalStreamOpcode; payload: Uint8Array<ArrayBufferLike> }[] = []
    const emit = vi.fn()
    let readCount = 0
    const outputBatcherPush = vi.fn()
    const stream: TerminalMultiplexStream = {
      streamId: 7,
      terminal: 'terminal',
      ptyId: 'pty',
      client: undefined,
      isMobile: false,
      ackOutput: false,
      ackInFlightBytes: 0,
      ackWindowBytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
      supportsOutputPause: false,
      supportsOutputPauseDropNotice: false,
      pausedOutputDropNoticeSent: false,
      supportsWriteUnavailable: false,
      supportsEndpointLossNotice: false,
      inputSessionId: null,
      outputPaused: false,
      supportsOutputCadence: false,
      supportsDesktopViewportClaims: false,
      desktopClaimTail: Promise.resolve(true),
      registeredRemoteDesktopDriver: false,
      remoteDesktopSubscriptionKey: 'multiplex:connection:7',
      pendingRemoteDesktopViewport: null,
      buffering: true,
      ackPendingOutput: [],
      ackPendingOutputBytes: 0,
      ackPendingOutputOverflowed: false,
      ackRecoverySnapshotInFlight: false,
      ackRecoveryAwaitedBytes: 0,
      ackPendingHoldbackBytes: 0,
      ackAdmittedPacedWindowBytes: null,
      ackOutputWaited: false,
      yieldedQueries: [],
      yieldedQueryScan: EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
      ackRecoveryHistoryOwed: false,
      pendingOutput: [{ data: 'lost-live', bytes: 9 }],
      pendingOutputBytes: 9,
      pendingOutputOverflowed: true,
      lastResizeCols: undefined,
      resizeGeneration: 0,
      outputBatcher: {
        push: outputBatcherPush,
        flush: vi.fn(),
        setCadence: vi.fn(),
        dispose: vi.fn()
      },
      unsubscribeData: () => {},
      unsubscribeResize: () => {},
      unsubscribeFit: () => {},
      unsubscribeDriver: () => {},
      unregisterBinaryHandler: () => {},
      exitWaiterAbort: new AbortController()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the runtime reads made by initial snapshot publication.
    const runtime = {
      getPtyExecutionHostMetadata: () => ({}),
      getTerminalLaunchResult: () => undefined,
      resolveLiveLeafForHandle: () => ({ ptyId: stream.ptyId }),
      readTerminal: vi.fn(async () => {
        readCount += 1
        if (readCount === 2) {
          stream.pendingOutputOverflowed = true
        }
        return { tail: ['fallback'] }
      }),
      serializeTerminalBuffer: vi.fn(async () => ({
        data: 'AUTHORITATIVE_INITIAL_MARKER',
        cols: 80,
        rows: 24,
        seq: 41,
        scrollbackRows: 0,
        truncatedByByteBudget: false
      })),
      getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getMobileDisplayMode: vi.fn(() => 'fit'),
      getLayout: vi.fn(() => null)
    } as unknown as OrcaRuntimeService
    const state = {
      runtime,
      streams: new Map([[stream.streamId, stream]]),
      emit,
      closed: false,
      sendFrame: vi.fn((streamId, opcode, payload = new Uint8Array()) => {
        expect(streamId).toBe(stream.streamId)
        frames.push({ opcode, payload })
        return true
      })
    } as unknown as TerminalMultiplexConnection

    await publishMultiplexInitialSnapshot(
      state,
      { streamId: stream.streamId, terminal: stream.terminal },
      stream
    )

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subscribed', truncated: true })
    )
    expect(frames.map(({ opcode }) => opcode)).toEqual([
      TerminalStreamOpcode.SnapshotStart,
      TerminalStreamOpcode.SnapshotChunk,
      TerminalStreamOpcode.SnapshotEnd
    ])
    expect(decodeTerminalStreamJson(frames[0]!.payload)).toMatchObject({
      seq: 41,
      truncated: true
    })
    expect(decodeTerminalStreamText(frames[1]!.payload)).toBe('AUTHORITATIVE_INITIAL_MARKER')
    expect(outputBatcherPush).not.toHaveBeenCalled()
  })
})
