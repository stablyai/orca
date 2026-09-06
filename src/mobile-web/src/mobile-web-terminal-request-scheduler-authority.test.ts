import { describe, expect, it, vi } from 'vitest'
import type { MobileWebTerminalRequest } from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { MobileWebTerminalRequestScheduler } from './mobile-web-terminal-request-scheduler'

const STREAM_ID = 'T'.repeat(22)

describe('MobileWebTerminalRequestScheduler authority lifecycle', () => {
  it('drops host readiness and write authority when the terminal goes invisible', async () => {
    const harness = createHarness()
    harness.scheduler.markBridgeReady()
    harness.scheduler.markHostReady(true)

    await expect(harness.scheduler.sendInputAsync('input', 'YQ==')).resolves.toBe(true)
    expect(harness.operations('input')).toHaveLength(1)

    harness.scheduler.setVisible(false)

    await expect(harness.scheduler.sendInputAsync('input', 'Yg==')).resolves.toBe(false)
    await expect(harness.scheduler.sendInputAsync('queryReply', 'Yw==')).resolves.toBe(false)
    await expect(harness.scheduler.pasteClipboard(true)).resolves.toBeNull()
    harness.scheduler.acknowledge(9)
    await Promise.resolve()

    expect(harness.operations('input')).toHaveLength(1)
    expect(harness.operations('queryReply')).toHaveLength(0)
    expect(harness.operations('ack')).toHaveLength(0)
    expect(harness.deviceInputRequest).not.toHaveBeenCalled()
  })

  it('re-checks authority after the queue drains, not only before enqueue', async () => {
    const inFlight = deferred<null>()
    const harness = createHarness((request) =>
      request.operation === 'input' && inFlight.pending() ? inFlight.promise : Promise.resolve(null)
    )
    harness.scheduler.markHostReady(true)

    const first = harness.scheduler.sendInputAsync('input', 'YQ==')
    const queued = harness.scheduler.sendInputAsync('input', 'Yg==')
    await vi.waitFor(() => expect(harness.operations('input')).toHaveLength(1))

    // Authority is revoked while the queued write is still parked behind the in-flight one.
    harness.scheduler.setVisible(false)
    inFlight.resolve(null)

    await expect(first).resolves.toBe(true)
    await expect(queued).resolves.toBe(false)
    expect(harness.operations('input')).toHaveLength(1)
  })

  it('sends a query reply only when the shell reported a negotiated reply opcode', async () => {
    const harness = createHarness()
    harness.scheduler.markHostReady(false)

    await expect(harness.scheduler.sendInputAsync('queryReply', 'YQ==')).resolves.toBe(false)
    await expect(harness.scheduler.sendInputAsync('input', 'Yg==')).resolves.toBe(true)
    harness.scheduler.markHostReady(true)
    await expect(harness.scheduler.sendInputAsync('queryReply', 'Yw==')).resolves.toBe(true)

    expect(harness.operations('queryReply')).toHaveLength(1)
    expect(harness.operations('input')).toHaveLength(1)
  })

  it('makes every entry point inert after dispose', async () => {
    const harness = createHarness()
    harness.scheduler.markBridgeReady()
    harness.scheduler.markHostReady(true)
    harness.scheduler.dispose()

    harness.scheduler.markBridgeReady()
    harness.scheduler.markHostReady(true)
    harness.scheduler.acknowledge(4)
    harness.scheduler.resize({ cols: 80, rows: 24 })
    harness.scheduler.setVisible(true)
    harness.scheduler.requestResync(3, 'gap')
    await expect(harness.scheduler.sendInputAsync('input', 'YQ==')).resolves.toBe(false)
    await expect(harness.scheduler.pasteClipboard(true)).resolves.toBeNull()
    await expect(harness.scheduler.attachImage('files')).resolves.toBeNull()
    await expect(harness.scheduler.setDisplayMode('auto', null)).resolves.toBe(false)
    await expect(harness.scheduler.clear()).resolves.toBe(false)
    await expect(harness.scheduler.rename('title')).resolves.toBe(false)

    expect(harness.request).not.toHaveBeenCalled()
    expect(harness.deviceInputRequest).not.toHaveBeenCalled()
    expect(harness.onError).not.toHaveBeenCalled()
  })
})

function createHarness(
  respond: (request: MobileWebTerminalRequest) => Promise<null> = () => Promise.resolve(null)
) {
  const request = vi.fn(respond)
  const deviceInputRequest = vi.fn().mockResolvedValue({ status: 'accepted' })
  const onError = vi.fn()
  const client = {
    terminalRequest: request,
    terminalDeviceInputRequest: deviceInputRequest
  } as unknown as MobileWebBridgeClient
  return {
    scheduler: new MobileWebTerminalRequestScheduler(client, STREAM_ID, onError),
    request,
    deviceInputRequest,
    onError,
    operations: (operation: MobileWebTerminalRequest['operation']) =>
      request.mock.calls.filter(([payload]) => payload.operation === operation)
  }
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
