import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebTerminalEvent } from '../../../src/shared/mobile-web/terminal-stream-contract'
import { webHostSessionTerminalOperations } from './web-host-session-terminal-operations'

const STREAM_ID = 'S'.repeat(22)
const SNAPSHOT_ID = 'N'.repeat(22)
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const OSC_LINKS = [{ row: 0, startCol: 0, endCol: 7, uri: 'file:///tmp/a.ts' }]

describe('web host session terminal operations', () => {
  it('adapts the strict opaque stream into the existing terminal presentation contract', async () => {
    const harness = bridgeHarness()
    const operations = webHostSessionTerminalOperations(harness.client)
    const onEvent = vi.fn()
    const cleanup = operations.subscribe(
      {
        workspaceId: 'workspace-page-1',
        terminalId: 'tab-page-1',
        clientId: null,
        viewport: { cols: 90, rows: 30 },
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      onEvent,
      vi.fn()
    )

    expect(harness.terminalSubscribe).toHaveBeenCalledWith(
      {
        operation: 'subscribe',
        workspaceId: 'workspace-page-1',
        tabId: 'tab-page-1',
        viewport: { cols: 90, rows: 30 },
        visible: true
      },
      expect.any(Function),
      expect.any(Function)
    )

    harness.emit(subscribed())
    harness.emit({
      type: 'output',
      streamId: STREAM_ID,
      startSequence: 0,
      endSequence: 2,
      data: 'b2s='
    })
    expect(onEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: 'subscribed', cols: 90, rows: 30 })
    )
    expect(onEvent).toHaveBeenNthCalledWith(2, {
      type: 'data',
      chunk: new Uint8Array([111, 107]),
      throughSequence: 2
    })

    operations.acknowledge('tab-page-1', 2)
    await vi.waitFor(() =>
      expect(harness.terminalRequest).toHaveBeenCalledWith({
        operation: 'ack',
        streamId: STREAM_ID,
        throughSequence: 2
      })
    )
    cleanup()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('orders bounded input and keeps query replies on their dedicated operation', async () => {
    const harness = bridgeHarness()
    const operations = webHostSessionTerminalOperations(harness.client)
    operations.subscribe(
      {
        workspaceId: 'workspace-page-1',
        terminalId: 'tab-page-1',
        clientId: null,
        viewport: null,
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      vi.fn(),
      vi.fn()
    )
    harness.emit(subscribed())

    await expect(operations.sendInput('tab-page-1', 'echo ok', true, null)).resolves.toBe(true)
    await expect(operations.sendQueryReply('tab-page-1', '\u001b[0n', null, false)).resolves.toBe(
      true
    )
    expect(harness.terminalRequest.mock.calls.slice(0, 2).map(([request]) => request)).toEqual([
      {
        operation: 'input',
        streamId: STREAM_ID,
        sequence: 0,
        data: 'ZWNobyBvaw0='
      },
      {
        operation: 'queryReply',
        streamId: STREAM_ID,
        sequence: 1,
        data: 'G1swbg=='
      }
    ])
    await expect(operations.pasteClipboard?.('tab-page-1', true)).resolves.toEqual({
      status: 'accepted'
    })
    await expect(operations.attachImage?.('tab-page-1', 'library')).resolves.toEqual({
      status: 'cancelled'
    })
    expect(harness.terminalDeviceInputRequest.mock.calls.map(([request]) => request)).toEqual([
      {
        operation: 'clipboardPaste',
        streamId: STREAM_ID,
        sequence: 2,
        bracketedPaste: true
      },
      {
        operation: 'attachImage',
        streamId: STREAM_ID,
        sequence: 3,
        source: 'library'
      }
    ])

    await expect(
      operations.setDisplayMode('tab-page-1', 'auto', { cols: 90, rows: 30 }, null)
    ).resolves.toBe(true)
    await expect(operations.rename('tab-page-1', 'Build')).resolves.toBe(true)
    await expect(operations.clear('tab-page-1')).resolves.toBe(true)
    expect(harness.terminalRequest.mock.calls.slice(2).map(([request]) => request)).toEqual([
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

  it('preserves snapshot OSC links for the existing terminal presentation', () => {
    const harness = bridgeHarness()
    const operations = webHostSessionTerminalOperations(harness.client)
    const onEvent = vi.fn()
    operations.subscribe(
      {
        workspaceId: 'workspace-page-1',
        terminalId: 'tab-page-1',
        clientId: null,
        viewport: { cols: 90, rows: 30 },
        visible: true,
        capabilities: { terminalBinaryStream: 1 }
      },
      onEvent,
      vi.fn()
    )
    harness.emit(subscribed())
    harness.emit({
      type: 'snapshotStart',
      streamId: STREAM_ID,
      snapshotId: SNAPSHOT_ID,
      kind: 'initial',
      viewport: { cols: 90, rows: 30 },
      totalBytes: 0,
      throughSequence: 0,
      sha256: EMPTY_SHA256,
      truncated: false,
      source: 'host-model',
      oscLinks: OSC_LINKS
    })
    harness.emit({
      type: 'snapshotEnd',
      streamId: STREAM_ID,
      snapshotId: SNAPSHOT_ID,
      totalBytes: 0,
      throughSequence: 0,
      sha256: EMPTY_SHA256
    })

    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'scrollback',
      cols: 90,
      rows: 30,
      serialized: new Uint8Array(),
      preserveScroll: false,
      throughSequence: 0,
      oscLinks: OSC_LINKS
    })
  })
})

function bridgeHarness(): {
  client: MobileWebBridgeClient
  terminalSubscribe: ReturnType<typeof vi.fn>
  terminalRequest: ReturnType<typeof vi.fn>
  terminalDeviceInputRequest: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  emit: (event: MobileWebTerminalEvent) => void
} {
  let onEvent = (_event: MobileWebTerminalEvent): void => {}
  const unsubscribe = vi.fn()
  const terminalSubscribe = vi.fn((_payload, listener: typeof onEvent) => {
    onEvent = listener
    return { streamId: STREAM_ID, ready: Promise.resolve(), unsubscribe }
  })
  const terminalRequest = vi.fn().mockResolvedValue(null)
  const terminalDeviceInputRequest = vi
    .fn()
    .mockResolvedValueOnce({ status: 'accepted' })
    .mockResolvedValueOnce({ status: 'cancelled' })
  return {
    client: {
      terminalSubscribe,
      terminalRequest,
      terminalDeviceInputRequest
    } as unknown as MobileWebBridgeClient,
    terminalSubscribe,
    terminalRequest,
    terminalDeviceInputRequest,
    unsubscribe,
    emit: (event) => onEvent(event)
  }
}

function subscribed(): MobileWebTerminalEvent {
  return {
    type: 'subscribed',
    streamId: STREAM_ID,
    viewport: { cols: 90, rows: 30 },
    startSequence: 0,
    maxOutstandingBytes: 256 * 1024,
    queryReplyNegotiated: true
  }
}
