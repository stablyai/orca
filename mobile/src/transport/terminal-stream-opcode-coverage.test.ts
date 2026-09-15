import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
// Deliberately mobile's own module: it is the one that drifted, so it is the one under test.
import { decodeTerminalStreamFrame } from './terminal-stream-protocol'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'

/**
 * The drift guard. Mobile used to vendor its own opcode list, so an opcode added on the host was
 * simply absent here and its frames decoded to null — STA-3482 lost terminal output that way and
 * nothing failed. Mobile now shares the enum, which removes the "absent" failure mode but not the
 * "present and silently unhandled" one.
 *
 * So: probe every opcode the shared enum defines and require each to be either handled or listed
 * below as deliberately ignored. Adding an opcode to `src/shared/terminal-stream-protocol.ts`
 * fails this test until someone decides which it is. That decision is the thing that was missing.
 *
 * This asserts on observed behavior rather than mirroring a list, so it cannot pass by being
 * updated in lockstep with a copy of the handler's branches.
 */

/** Host -> client opcodes mobile acts on. */
const HANDLED: readonly TerminalStreamOpcode[] = [
  TerminalStreamOpcode.Output,
  TerminalStreamOpcode.OutputSpan,
  TerminalStreamOpcode.SnapshotStart,
  TerminalStreamOpcode.SnapshotChunk,
  TerminalStreamOpcode.SnapshotEnd,
  TerminalStreamOpcode.Resized,
  TerminalStreamOpcode.Metadata,
  TerminalStreamOpcode.Error
]

/**
 * Ignored on purpose. Everything here except `WriteUnavailable` is client -> host: mobile sends
 * these (or does not use them) and never receives them, so there is nothing to handle.
 *
 * `WriteUnavailable` is the one genuine host -> client gap. The desktop multiplexer surfaces it
 * via `onWriteUnavailable`; mobile has no equivalent, so a phone whose writes are refused gets no
 * signal. Listed rather than fixed here to keep this change to one concern — but listed, so it is
 * a known gap instead of an invisible one.
 */
const DELIBERATELY_IGNORED: readonly TerminalStreamOpcode[] = [
  TerminalStreamOpcode.Input,
  TerminalStreamOpcode.Resize,
  TerminalStreamOpcode.Subscribe,
  TerminalStreamOpcode.Unsubscribe,
  TerminalStreamOpcode.SnapshotRequest,
  TerminalStreamOpcode.Ack,
  TerminalStreamOpcode.ClaimViewport,
  TerminalStreamOpcode.SetOutputPaused,
  TerminalStreamOpcode.WriteUnavailable
]

function allOpcodes(): TerminalStreamOpcode[] {
  return Object.values(TerminalStreamOpcode)
    .filter((value): value is TerminalStreamOpcode => typeof value === 'number')
    .sort((a, b) => a - b)
}

function opcodeName(opcode: TerminalStreamOpcode): string {
  return `${TerminalStreamOpcode[opcode] ?? 'Unnamed'}(${opcode})`
}

/**
 * A payload that is simultaneously valid JSON carrying the OutputSpan contract and valid text,
 * so one probe reaches every handled branch without encoding per-opcode expectations here.
 */
function probePayload(): Uint8Array {
  return encodeTerminalStreamJson({ data: 'probe', rawLength: 5, transformed: true })
}

/** Did the handler do anything observable with this frame? */
function producesEffect(opcode: TerminalStreamOpcode): boolean {
  const listener = vi.fn()
  const recordValidatedInboundTraffic = vi.fn()
  const terminalSnapshots = new Map()

  handleTerminalBinaryFrame(
    encodeTerminalStreamFrame({ opcode, streamId: 3, seq: 9, payload: probePayload() }),
    {
      terminalSnapshots,
      getListener: (streamId) => (streamId === 3 ? listener : undefined),
      recordValidatedInboundTraffic
    }
  )

  return (
    listener.mock.calls.length > 0 ||
    recordValidatedInboundTraffic.mock.calls.length > 0 ||
    terminalSnapshots.size > 0
  )
}

describe('terminal stream opcode coverage', () => {
  it('classifies every shared opcode as handled or deliberately ignored', () => {
    const classified = new Set<number>([...HANDLED, ...DELIBERATELY_IGNORED])
    const unclassified = allOpcodes().filter((opcode) => !classified.has(opcode))

    expect(
      unclassified.map(opcodeName),
      'A new terminal stream opcode reached src/shared without a mobile decision. Handle it in ' +
        'rpc-client-terminal-binary-frame.ts, or add it to DELIBERATELY_IGNORED with why.'
    ).toEqual([])
  })

  it.each(HANDLED.map((opcode) => [opcodeName(opcode), opcode] as const))(
    'acts on %s',
    (_name, opcode) => {
      expect(producesEffect(opcode)).toBe(true)
    }
  )

  it.each(DELIBERATELY_IGNORED.map((opcode) => [opcodeName(opcode), opcode] as const))(
    'ignores %s',
    (_name, opcode) => {
      expect(producesEffect(opcode)).toBe(false)
    }
  )

  it('decodes every shared opcode instead of dropping the frame', () => {
    // Why STA-3482 was data loss and not merely a missing feature: an unknown opcode used to
    // null out the whole frame. Unknown must mean "ignored", never "discarded silently".
    // Decoded through mobile's own module entry point, which is what drifted.
    for (const opcode of allOpcodes()) {
      const decoded = decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({ opcode, streamId: 1, seq: 1, payload: probePayload() })
      )
      expect(decoded, `${opcodeName(opcode)} must decode`).not.toBeNull()
      expect(decoded?.opcode).toBe(opcode)
    }
  })
})
