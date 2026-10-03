import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createBandwidthChannel } from './runtime-bandwidth-channel-fixture'
import { bandwidthResponse } from '../../../shared/remote-runtime-bandwidth-fixture'
import { decrypt, decryptBytes } from '../../../shared/e2ee-crypto'
import {
  decodeRuntimeSnapshotResponse,
  RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY
} from '../../../shared/remote-runtime-snapshot-compression'
import { createRuntimeSnapshotReply } from './runtime-snapshot-reply'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
afterEach(() => vi.useRealTimers())

describe('compressed snapshots preserve outbound admission', () => {
  it('parks and drains every snapshot in order after a blocked socket recovers', () => {
    vi.useFakeTimers()
    const channel = createBandwidthChannel(true)
    try {
      channel.socket.bufferedAmount = 9 * 1024 * 1024
      for (let version = 1; version <= 20; version++) {
        channel.reply('session.tabs.subscribeAll', bandwidthResponse(version))
      }
      expect(channel.sent).toEqual([])
      channel.socket.bufferedAmount = 0
      vi.runOnlyPendingTimers()
      expect(channel.sent).toHaveLength(20)
      channel.sent.forEach((frame, index) => {
        if (typeof frame !== 'string') {
          throw new Error('Expected text frame')
        }
        expect(
          decodeRuntimeSnapshotResponse(JSON.parse(decrypt(frame, channel.key)!), true)
        ).toEqual(JSON.parse(bandwidthResponse(index + 1)))
      })
      expect(channel.failures).toEqual([])
    } finally {
      channel.close()
    }
  })

  it('bounds a wedged peer and releases its queue on disconnect', () => {
    vi.useFakeTimers()
    const channel = createBandwidthChannel(true)
    channel.socket.bufferedAmount = 9 * 1024 * 1024
    const response = bandwidthResponse(1)
    for (let count = 0; count < 4097; count++) {
      channel.reply('session.tabs.subscribeAll', response)
    }
    expect(channel.failures).toEqual(['Outbound reply buffer overflow'])
    channel.close()
    channel.socket.bufferedAmount = 0
    vi.runOnlyPendingTimers()
    expect(channel.sent).toEqual([])
  })

  it('leaves incompressible binary terminal output byte-exact', () => {
    const channel = createBandwidthChannel(true)
    try {
      const bytes = randomBytes(64 * 1024)
      expect(channel.binary(bytes)).toBe(true)
      const sent = channel.sent[0]!
      if (typeof sent === 'string') {
        throw new Error('Expected binary frame')
      }
      expect(sent.byteLength).toBe(bytes.byteLength + 40)
      expect(Buffer.from(decryptBytes(sent, channel.key)!)).toEqual(bytes)
    } finally {
      channel.close()
    }
  })

  it.each([
    ['session.tabs.subscribeAll', 'runtime', []],
    ['session.tabs.subscribeAll', 'mobile', [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY]],
    ['files.read', 'runtime', [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY]],
    ['terminal.subscribe', 'runtime', [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY]],
    ['status.get', 'runtime', [RUNTIME_SNAPSHOT_DEFLATE_CAPABILITY]]
  ] as const)(
    'keeps %s / %s outside the compression boundary when not negotiated',
    (method, scope, capabilities) => {
      const reply = vi.fn()
      expect(createRuntimeSnapshotReply(method, scope, capabilities, reply)).toBe(reply)
    }
  )
})
