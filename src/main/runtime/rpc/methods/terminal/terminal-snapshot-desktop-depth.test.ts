import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SNAPSHOT_BYTE_BUDGET,
  DESKTOP_SUBSCRIBE_SCROLLBACK_ROWS,
  MOBILE_SNAPSHOT_BYTE_BUDGET,
  MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
} from '../../../terminal/output/mobile-scrollback-limits'
import {
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES } from '../../../../../shared/remote-runtime/remote-runtime-memory-limits'

/** A pane whose history is `historyRows` rows of `bytesPerRow` bytes; a snapshot carries the last `scrollbackRows`. */
function pane(historyRows: number, bytesPerRow: number) {
  const asked: number[] = []
  const runtime = {
    serializeTerminalBuffer: async (_ptyId: string, options: { scrollbackRows: number }) => {
      asked.push(options.scrollbackRows)
      const rows = Math.min(historyRows, options.scrollbackRows)
      return {
        data: 'screen\r\n',
        scrollbackAnsi: `${'x'.repeat(bytesPerRow - 2)}\r\n`.repeat(rows),
        cols: 120,
        rows: 30,
        seq: 1
      }
    }
  }
  type Source = Parameters<typeof serializeBudgetedMobileSnapshot>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the serializer only calls serializeTerminalBuffer on this runtime.
  const source = runtime as unknown as Source
  return { runtime: source, asked }
}

function historyRowsIn(
  snapshot: Awaited<ReturnType<typeof serializeBudgetedMobileSnapshot>>
): number {
  return (snapshot?.data.match(/x\r\n/g) ?? []).length
}

const desktop = [DESKTOP_SUBSCRIBE_SCROLLBACK_ROWS, DESKTOP_SNAPSHOT_BYTE_BUDGET] as const
const mobile = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, MOBILE_SNAPSHOT_BYTE_BUDGET] as const

describe('desktop-depth subscribe snapshots (N-02)', () => {
  it('a desktop subscriber gets the whole history a local terminal keeps (seq 1 2000)', async () => {
    const { runtime } = pane(2000, 5)
    const snapshot = await serializeBudgetedMobileSnapshot(runtime, 'pty', undefined, ...desktop)
    expect(historyRowsIn(snapshot)).toBe(2000)
  })

  it('a phone keeps the phone-sized cut', async () => {
    const { runtime } = pane(2000, 5)
    const snapshot = await serializeBudgetedMobileSnapshot(runtime, 'pty', undefined, ...mobile)
    expect(historyRowsIn(snapshot)).toBe(1000)
  })

  it('heavy rows step down to the largest depth under the desktop budget', async () => {
    // 5000 rows of 600 B (~3 MB) is over 2 MB; 2000 rows (~1.2 MB) fits.
    const { runtime, asked } = pane(5000, 600)
    const snapshot = await serializeBudgetedMobileSnapshot(runtime, 'pty', undefined, ...desktop)
    expect(asked.slice(0, 2)).toEqual([5000, 2000])
    expect(historyRowsIn(snapshot)).toBe(2000)
    expect(snapshot?.data.length ?? 0).toBeLessThanOrEqual(DESKTOP_SNAPSHOT_BYTE_BUDGET)
  })

  it('a full desktop-budget snapshot goes out in frames no larger than any receiver cap', () => {
    const frames: Uint8Array[] = []
    // A worst case at the budget: 2 MB of escape-heavy text.
    const data = '\x1b[31mx\x1b[0m'.repeat(Math.floor(DESKTOP_SNAPSHOT_BYTE_BUDGET / 10))
    const result = sendSnapshotFrames(
      (_opcode, payload) => {
        if (payload) {
          frames.push(payload)
        }
        return true
      },
      { kind: 'scrollback', cols: 120, rows: 30, data }
    )
    expect(result.published).toBe(true)
    const largest = Math.max(...frames.map((frame) => frame.byteLength))
    expect(largest).toBeLessThanOrEqual(TERMINAL_STREAM_CHUNK_BYTES + 64)
    expect(largest).toBeLessThanOrEqual(REMOTE_RUNTIME_MAX_INBOUND_FRAME_BYTES)
  })

  it('a desktop held to phone-sized limits behaves exactly as before', async () => {
    const before = pane(5000, 600)
    const asDesktopAtPhoneLimits = pane(5000, 600)
    const legacy = await serializeBudgetedMobileSnapshot(before.runtime, 'pty')
    const now = await serializeBudgetedMobileSnapshot(
      asDesktopAtPhoneLimits.runtime,
      'pty',
      undefined,
      ...mobile
    )
    expect(asDesktopAtPhoneLimits.asked).toEqual(before.asked)
    expect(historyRowsIn(now)).toBe(historyRowsIn(legacy))
    expect(now?.data.length ?? 0).toBeLessThanOrEqual(MOBILE_SNAPSHOT_BYTE_BUDGET)
  })
})
