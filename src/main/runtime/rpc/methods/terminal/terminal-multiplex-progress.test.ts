import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalStreamProgressReporter } from '../../../../observability/terminal-stream-progress'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { stubRuntime } from '../../terminal-multiplex-test-harness'
import { TerminalSourceRangeLedger } from '../../terminal-source-range-ledger'
import { TerminalSourceRangeRegistry } from '../../terminal-source-range-registry'
import { installMultiplexFrameDelivery } from './terminal-multiplex-frame-delivery'
import { installMultiplexFlowControl } from './terminal-multiplex-flow-control'
import { installMultiplexCleanup } from './terminal-multiplex-cleanup'
import { installMultiplexSlotFrames } from './terminal-multiplex-slot-frames'
import { handleTerminalMultiplexInput } from './terminal-multiplex-input-progress'
import { getTerminalMultiplexProgress } from './terminal-multiplex-progress'
import type { TerminalMultiplexConnectionBase } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import type { DriverState } from '../../../orca-runtime'

function fixture() {
  const getDriver = vi.fn<() => DriverState>(() => ({ kind: 'idle' }))
  const sendTerminal = vi.fn().mockResolvedValue({ accepted: true })
  const ledger = new TerminalSourceRangeLedger('generation-1')
  const stream: TerminalMultiplexStream = {
    streamId: 7,
    terminal: 'terminal-1',
    ptyId: 'pty-1',
    client: { id: 'client-1', type: 'desktop' },
    isMobile: false,
    ackOutput: true,
    ackOutputSourceRanges: false,
    streamGeneration: 'generation-1',
    sourceRangeLedger: ledger,
    sourceRangeConsumerAttached: false,
    sourceRangeReplacement: null,
    ackInFlightBytes: 0,
    ackWindowBytes: 100,
    supportsOutputPause: true,
    supportsWriteUnavailable: true,
    outputPaused: false,
    supportsDesktopViewportClaims: false,
    desktopClaimTail: Promise.resolve(true),
    registeredRemoteDesktopDriver: false,
    remoteDesktopSubscriptionKey: 'stream-7',
    pendingRemoteDesktopViewport: null,
    buffering: false,
    ackPendingOutput: [],
    ackPendingOutputBytes: 0,
    ackPendingOutputOverflowed: false,
    ackRecoverySnapshotInFlight: false,
    pendingOutput: [],
    pendingOutputBytes: 0,
    pendingOutputOverflowed: false,
    lastResizeCols: undefined,
    resizeGeneration: 0,
    outputBatcher: { push: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    unsubscribeData: vi.fn(),
    unsubscribeResize: vi.fn(),
    unsubscribeFit: vi.fn(),
    unsubscribeDriver: vi.fn(),
    unregisterBinaryHandler: vi.fn(),
    exitWaiterAbort: new AbortController()
  }
  const base: TerminalMultiplexConnectionBase = {
    runtime: stubRuntime({ getDriver, sendTerminal }),
    connectionId: 'connection-1',
    requestId: 'request-1',
    sendBinary: vi.fn(),
    registerBinaryStreamHandler: vi.fn(() => vi.fn()),
    signal: undefined,
    emit: vi.fn(),
    closed: false,
    cursor: 0,
    streams: new Map([[7, stream]]),
    sourceRangeRegistry: new TerminalSourceRangeRegistry(),
    pendingPtyWaitControllers: new Map(),
    ackTotalInFlightBytes: 0,
    ackTotalWindowBytes: 200,
    ackFlushCursorStreamId: null,
    resolveMultiplex: vi.fn(),
    multiplexClosed: Promise.resolve(),
    unregisterControlHandler: vi.fn()
  }
  installMultiplexFrameDelivery(base)
  installMultiplexFlowControl(base)
  installMultiplexCleanup(base)
  installMultiplexSlotFrames(base)
  const state = Object.assign(base, { handleSubscribeFrame: vi.fn(async () => {}) })
  const entry = getTerminalMultiplexProgress(state, stream)
  return { state, stream, ledger, entry, getDriver, sendTerminal }
}

describe('terminal multiplex progress observations', () => {
  beforeEach(() => {
    vi.spyOn(terminalStreamProgressReporter, 'schedule').mockImplementation(() => {})
    vi.spyOn(terminalStreamProgressReporter, 'clear').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('does not charge a successfully sent chunk again in later refusal summaries', () => {
    const { state, stream, entry } = fixture()
    expect(state.canSendAckGatedOutput(stream, 70)).toBe(true)
    expect(state.sendAckGatedOutput(stream, { bytes: new Uint8Array(70), displayLength: 1 })).toBe(true)
    expect(stream.ackInFlightBytes).toBe(70)
    expect(entry.progress.snapshot()).toMatchObject({
      chunkBytes: 0,
      streamCreditBlocked: false,
      connectionCreditBlocked: false,
      ledgerChecked: false
    })
  })

  it('distinguishes simultaneous stream and connection debt without probing the ledger', () => {
    const { state, stream, ledger, entry } = fixture()
    stream.ackOutputSourceRanges = true
    stream.ackInFlightBytes = 100
    state.ackTotalInFlightBytes = 200
    const canAccept = vi.spyOn(ledger, 'canAccept')

    expect(state.canSendAckGatedOutput(stream, 1)).toBe(false)
    expect(entry.progress.snapshot()).toMatchObject({
      streamCreditBlocked: true,
      connectionCreditBlocked: true,
      ledgerChecked: false,
      ledgerAllowed: null
    })
    expect(canAccept).not.toHaveBeenCalled()
    expect(entry.progress.identity).toMatchObject({ requestId: 'request-1', streamId: 7 })
  })

  it('uses the single ledger predicate result for a read-only snapshot', () => {
    const { state, stream, ledger, entry } = fixture()
    stream.ackOutputSourceRanges = true
    const canAccept = vi.spyOn(ledger, 'canAccept').mockReturnValue(false)

    expect(state.canSendAckGatedOutput(stream, 1)).toBe(false)
    expect(entry.progress.snapshot()).toMatchObject({ ledgerChecked: true, ledgerAllowed: false })
    expect(canAccept).toHaveBeenCalledOnce()
  })

  it.each(['capacity', 'commit'] as const)('does not recover credit when %s admission fails', (failure) => {
    const { state, stream, ledger, entry } = fixture()
    stream.ackOutputSourceRanges = true
    stream.ackInFlightBytes = 100
    expect(state.canSendAckGatedOutput(stream, 1)).toBe(false)
    stream.ackInFlightBytes = 0
    expect(state.canSendAckGatedOutput(stream, 1)).toBe(true)
    const restored = vi.spyOn(entry.progress, 'creditRestored')
    const prepared = ledger.prepareAccept(1, 1, [])
    if (prepared.status !== 'ready') {
      throw new Error('Expected fixture admission')
    }
    prepared.admission.rollback()
    const prepare = vi.spyOn(ledger, 'prepareAccept').mockReturnValue(
      failure === 'capacity'
        ? { status: 'capacity' }
        : { status: 'ready', admission: { ...prepared.admission, commit: () => false } }
    )

    expect(state.sendAckGatedOutput(stream, { bytes: new Uint8Array([1]), displayLength: 1 })).toBe(false)
    expect(prepare).toHaveBeenCalledOnce()
    expect(restored).not.toHaveBeenCalled()
  })

  it('recovers only after a successful output send', () => {
    const { state, stream, entry } = fixture()
    const restored = vi.spyOn(entry.progress, 'creditRestored')

    expect(state.canSendAckGatedOutput(stream, 1)).toBe(true)
    expect(restored).not.toHaveBeenCalled()
    expect(state.sendAckGatedOutput(stream, { bytes: new Uint8Array([1]), displayLength: 1 })).toBe(true)
    expect(restored).toHaveBeenCalledOnce()
  })

  it('counts claim refusal without an extra lock check or terminal write', async () => {
    const { state, stream, entry, getDriver, sendTerminal } = fixture()
    stream.desktopClaimTail = Promise.resolve(false)

    handleTerminalMultiplexInput(state, stream, encodeTerminalStreamText('private-command'))
    expect(entry.inputAwaitingClaim).toBe(1)
    await Promise.resolve()

    expect(entry.inputAwaitingClaim).toBe(0)
    expect(getDriver).toHaveBeenCalledOnce()
    expect(sendTerminal).not.toHaveBeenCalled()
    expect(entry.progress.counters).toMatchObject({ inputReceived: 1, inputClaimRefused: 1 })
    expect(JSON.stringify(entry.progress.snapshot())).not.toContain('private-command')
  })

  it.each(['delivered', 'rejected', 'failed'] as const)('counts runtime %s without changing notification', async (outcome) => {
    const { state, stream, entry, getDriver, sendTerminal } = fixture()
    if (outcome === 'failed') {
      sendTerminal.mockRejectedValue(new Error('private-runtime-error'))
    } else {
      sendTerminal.mockResolvedValue({ accepted: outcome === 'delivered' })
    }
    const notify = vi.spyOn(state, 'notifyStreamWriteUnavailable')

    handleTerminalMultiplexInput(state, stream, encodeTerminalStreamText('x'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(getDriver).toHaveBeenCalledTimes(2)
    expect(sendTerminal).toHaveBeenCalledOnce()
    expect(entry.progress.counters).toMatchObject({
      [outcome === 'delivered' ? 'inputDelivered' : outcome === 'rejected' ? 'inputRejected' : 'inputFailed']: 1
    })
    expect(entry.inputDispatchPending).toBe(0)
    expect(notify).toHaveBeenCalledWith(stream, outcome)
  })

  it.each([1, 2])('counts a mobile lock at check %i without reading it again', async (check) => {
    const { state, stream, entry, getDriver, sendTerminal } = fixture()
    if (check === 2) {
      getDriver.mockReturnValueOnce({ kind: 'idle' })
    }
    getDriver.mockReturnValue({ kind: 'mobile', clientId: 'phone' })

    handleTerminalMultiplexInput(state, stream, encodeTerminalStreamText('x'))
    await Promise.resolve()

    expect(getDriver).toHaveBeenCalledTimes(check)
    expect(sendTerminal).not.toHaveBeenCalled()
    expect(entry.progress.counters.inputMobileLocked).toBe(1)
  })

  it('counts invalid ACK schema and one rejected ledger acknowledgement', () => {
    const { state, stream, ledger, entry } = fixture()
    const ack = (payload: unknown) => state.handleSlotFrame(stream, {
      streamId: 7, seq: 0, opcode: TerminalStreamOpcode.Ack,
      payload: encodeTerminalStreamJson(payload)
    })
    ack({ bytes: 'invalid' })
    stream.ackOutputSourceRanges = true
    const acknowledge = vi.spyOn(ledger, 'acknowledge').mockReturnValue({ status: 'excessive', settled: [] })
    ack({ streamGeneration: 'generation-1', ackedEndByte: 100 })

    expect(acknowledge).toHaveBeenCalledOnce()
    expect(entry.progress.counters).toMatchObject({ ackReceived: 2, ackRejected: 2 })
    expect(terminalStreamProgressReporter.schedule).toHaveBeenCalledWith(entry.progress, 'ack_rejected', 1_000)
  })

  it('cancels paused and detached diagnostics without reporting credit recovery', () => {
    const { state, stream, entry } = fixture()
    const restored = vi.spyOn(entry.progress, 'creditRestored')
    const cancelled = vi.spyOn(entry.progress, 'creditCancelled')
    const disposed = vi.spyOn(entry.progress, 'dispose')
    state.handleSlotFrame(stream, {
      streamId: 7, seq: 0, opcode: TerminalStreamOpcode.SetOutputPaused,
      payload: encodeTerminalStreamJson({ paused: true })
    })
    expect(cancelled).toHaveBeenCalledOnce()
    state.detachStream(7, null)
    expect(disposed).toHaveBeenCalledOnce()
    expect(restored).not.toHaveBeenCalled()
  })
})
