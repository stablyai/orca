import { describe, expect, it, vi } from 'vitest'
import { decrypt, decryptBytes } from '../../../shared/e2ee-crypto'
import {
  bandwidthResponse,
  ConstrainedRuntimeLink
} from '../../../shared/remote-runtime-bandwidth-fixture'
import { createBandwidthChannel } from './runtime-bandwidth-channel-fixture'
import { decodeRuntimeSnapshotResponse } from '../../../shared/remote-runtime-snapshot-compression'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

function measure(compressed: boolean, terminalCount = 17) {
  const channel = createBandwidthChannel(compressed)
  const link = new ConstrainedRuntimeLink()
  const cpuStart = process.cpuUsage()
  const memoryStart = process.memoryUsage().rss
  try {
    for (let tick = 0; tick < 1020; tick++) {
      if (tick % 340 >= 300 || (tick % 340) % 5 === 0) {
        const snapshot = bandwidthResponse(tick, terminalCount)
        channel.reply('session.tabs.subscribeAll', snapshot)
        const frame = channel.sent.shift()!
        expect(typeof frame).toBe('string')
        if (typeof frame !== 'string') {
          throw new Error('Expected encrypted text')
        }
        const plaintext = decrypt(frame, channel.key)!
        expect(decodeRuntimeSnapshotResponse(JSON.parse(plaintext), compressed)).toEqual(
          JSON.parse(snapshot)
        )
        link.send(tick * 100, frame)
      }

      const terminal = encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: (tick % terminalCount) + 1,
        seq: tick,
        payload: Buffer.from('x'.repeat(210))
      })
      expect(channel.binary(terminal)).toBe(true)
      const binary = channel.sent.shift()!
      if (typeof binary === 'string') {
        throw new Error('Expected encrypted terminal bytes')
      }
      expect(Buffer.from(decryptBytes(binary, channel.key)!)).toEqual(Buffer.from(terminal))
      link.send(tick * 100, binary)
      if (tick % 5 === 0) {
        const method = tick % 10 ? 'files.list' : 'files.read'
        const response = JSON.stringify({
          id: tick,
          ok: true,
          result:
            method === 'files.list'
              ? { files: ['a.ts', 'b.ts'] }
              : { content: 'export const value = 42' }
        })
        channel.reply(method, response)
        const interactive = channel.sent.shift()!
        if (typeof interactive !== 'string') {
          throw new Error('Expected encrypted RPC')
        }
        expect(decrypt(interactive, channel.key)).toBe(response)
        link.send(tick * 100 + 10, interactive, true)
      }
    }
    expect(channel.failures).toEqual([])
    const cpu = process.cpuUsage(cpuStart)
    return {
      ...link.metrics(),
      cpuMs: (cpu.user + cpu.system) / 1000,
      rssDeltaBytes: process.memoryUsage().rss - memoryStart
    }
  } finally {
    channel.close()
  }
}

describe('remote runtime constrained-link bandwidth', () => {
  it.each([15, 17, 20])(
    'bounds RPC latency under %i terminals without dropping state or terminal bytes',
    (terminals) => {
      const baseline = measure(false, terminals)
      const improved = measure(true, terminals)
      console.info(JSON.stringify({ terminals, baseline, improved }))
      expect(baseline.rpcP95Ms).toBeGreaterThan(500)
      expect(improved.wireBytes).toBeLessThan(baseline.wireBytes * 0.6)
      expect(improved.rpcP95Ms).toBeLessThan(baseline.rpcP95Ms * 0.2)
      expect(improved.rpcMaxMs).toBeLessThan(1000)
      expect(improved.peakQueuedBytes).toBeLessThan(128 * 1024)
    }
  )
})
