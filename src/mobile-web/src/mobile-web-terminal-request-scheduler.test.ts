import { describe, expect, it, vi } from 'vitest'
import type { MobileWebTerminalRequest } from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { MobileWebTerminalRequestScheduler } from './mobile-web-terminal-request-scheduler'

const STREAM_ID = 'T'.repeat(22)
type TerminalRequest = Exclude<MobileWebTerminalRequest, { operation: 'subscribe' }>

describe('MobileWebTerminalRequestScheduler', () => {
  it('serializes input and advances its sequence only after success', async () => {
    const first = deferred<null>()
    const terminalRequest = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null)
    const scheduler = createScheduler(terminalRequest)
    scheduler.markHostReady(true)

    scheduler.sendInput('input', 'YQ==')
    scheduler.sendInput('input', 'Yg==')
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(1))
    first.resolve(null)
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(2))

    expect(terminalRequest.mock.calls.map(([request]) => request.sequence)).toEqual([0, 1])
  })

  it('reuses a rejected input sequence and respects current host authority', async () => {
    const terminalRequest = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(null)
    const onError = vi.fn()
    const scheduler = createScheduler(terminalRequest, onError)
    scheduler.markHostReady(true)

    scheduler.sendInput('input', 'YQ==')
    scheduler.sendInput('input', 'Yg==')
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(2))
    expect(terminalRequest.mock.calls.map(([request]) => request.sequence)).toEqual([0, 0])
    expect(onError).toHaveBeenCalledOnce()

    scheduler.setVisible(false)
    scheduler.sendInput('input', 'Yw==')
    scheduler.sendInput('queryReply', 'ZA==')
    await Promise.resolve()
    expect(terminalRequest).toHaveBeenCalledTimes(2)
  })

  it('coalesces ACKs and resize requests while preserving request order', async () => {
    const firstAck = deferred<null>()
    const firstResize = deferred<null>()
    const terminalRequest = vi.fn((request: TerminalRequest) => {
      if (request.operation === 'ack' && firstAck.pending()) {
        return firstAck.promise
      }
      if (request.operation === 'resize' && firstResize.pending()) {
        return firstResize.promise
      }
      return Promise.resolve(null)
    })
    const scheduler = createScheduler(terminalRequest)
    scheduler.markHostReady(true)

    scheduler.acknowledge(5)
    scheduler.acknowledge(8)
    scheduler.resize({ cols: 80, rows: 24 })
    scheduler.resize({ cols: 100, rows: 30 })
    expect(terminalRequest).toHaveBeenCalledTimes(2)

    firstAck.resolve(null)
    firstResize.resolve(null)
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(4))
    expect(
      terminalRequest.mock.calls
        .map(([request]) => request)
        .flatMap((request) => (request.operation === 'ack' ? [request.throughSequence] : []))
    ).toEqual([5, 8])
    expect(
      terminalRequest.mock.calls
        .map(([request]) => request)
        .flatMap((request) => (request.operation === 'resize' ? [request.viewport] : []))
    ).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 }
    ])
  })

  it('gates visibility and resync against their respective readiness states', async () => {
    const terminalRequest = vi.fn().mockResolvedValue(null)
    const scheduler = createScheduler(terminalRequest)

    scheduler.setVisible(false)
    expect(terminalRequest).not.toHaveBeenCalled()
    scheduler.markBridgeReady()
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(1))

    scheduler.requestResync(4, 'gap')
    expect(terminalRequest).toHaveBeenCalledTimes(1)
    scheduler.markHostReady(true)
    scheduler.requestResync(4, 'gap')
    scheduler.requestResync(4, 'gap')
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(2))
    scheduler.markResynced()
    scheduler.requestResync(8, 'overflow')
    await vi.waitFor(() => expect(terminalRequest).toHaveBeenCalledTimes(3))
  })

  it('routes bounded terminal actions only after the bridge subscription is ready', async () => {
    const terminalRequest = vi.fn().mockResolvedValue(null)
    const scheduler = createScheduler(terminalRequest)

    await expect(scheduler.clear()).resolves.toBe(false)
    scheduler.markBridgeReady()
    await expect(scheduler.setDisplayMode('auto', { cols: 90, rows: 30 })).resolves.toBe(true)
    await expect(scheduler.rename('Build')).resolves.toBe(true)
    await expect(scheduler.clear()).resolves.toBe(true)

    expect(terminalRequest.mock.calls.map(([request]) => request)).toEqual([
      {
        operation: 'displayMode',
        streamId: STREAM_ID,
        mode: 'auto',
        viewport: { cols: 90, rows: 30 }
      },
      { operation: 'rename', streamId: STREAM_ID, title: 'Build' },
      { operation: 'clear', streamId: STREAM_ID }
    ])
  })

  it('serializes shell-owned paste and picker actions with ordinary input', async () => {
    const terminalRequest = vi.fn().mockResolvedValue(null)
    const terminalDeviceInputRequest = vi
      .fn()
      .mockResolvedValueOnce({ status: 'accepted' })
      .mockResolvedValueOnce({ status: 'cancelled' })
    const scheduler = createScheduler(terminalRequest, vi.fn(), terminalDeviceInputRequest)
    scheduler.markHostReady(true)

    const input = scheduler.sendInputAsync('input', 'YQ==')
    const paste = scheduler.pasteClipboard(true)
    const attachment = scheduler.attachImage('files')

    await expect(input).resolves.toBe(true)
    await expect(paste).resolves.toEqual({ status: 'accepted' })
    await expect(attachment).resolves.toEqual({ status: 'cancelled' })
    expect(terminalRequest).toHaveBeenCalledWith({
      operation: 'input',
      streamId: STREAM_ID,
      sequence: 0,
      data: 'YQ=='
    })
    expect(terminalDeviceInputRequest.mock.calls.map(([request]) => request)).toEqual([
      {
        operation: 'clipboardPaste',
        streamId: STREAM_ID,
        sequence: 1,
        bracketedPaste: true
      },
      {
        operation: 'attachImage',
        streamId: STREAM_ID,
        sequence: 2,
        source: 'files'
      }
    ])
  })
})

function createScheduler(
  terminalRequest: ReturnType<typeof vi.fn>,
  onError = vi.fn(),
  terminalDeviceInputRequest = vi.fn().mockResolvedValue({ status: 'accepted' })
): MobileWebTerminalRequestScheduler {
  const client = { terminalRequest, terminalDeviceInputRequest } as unknown as MobileWebBridgeClient
  return new MobileWebTerminalRequestScheduler(client, STREAM_ID, onError)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  pending: () => boolean
} {
  let resolvePromise = (_value: T): void => {}
  let isPending = true
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      isPending = false
      resolvePromise(value)
    },
    pending: () => isPending
  }
}
