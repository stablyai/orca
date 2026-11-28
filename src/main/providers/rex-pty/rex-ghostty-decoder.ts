import { createHash } from 'node:crypto'
import { REX_MAX_SNAPSHOT_BYTES } from './rex-memory-budget'
import { RexGhosttyAbi } from './rex-ghostty-abi'
import type { RexDecodedSnapshot } from './rex-reattach'

export const REX_GHOSTTY_SHA256 = 'db63f0ed3525b5b562bdc80158bdca2bbdc1e978f8db5baf28d0db56b3fbdc2a'
const MAX_CONTINUATION = 1024 * 1024

function restore(abi: RexGhosttyAbi, bytes: Buffer, retain: boolean): number {
  const input = abi.alloc(bytes.length)
  const option = abi.alloc(4)
  try {
    abi.bytes(input, bytes.length).set(bytes)
    const decoder = abi.opaque((slot) =>
      abi.call('ghostty_snapshot_decoder_new_buf', 0, slot, input, bytes.length)
    )
    try {
      // MAX_CONTINUATION_BYTES=1, RETAIN_CONTINUATION=2, ABI 1.0.2.
      abi.view().setUint32(option, MAX_CONTINUATION, true)
      abi.check(abi.call('ghostty_snapshot_decoder_set', decoder, 1, option))
      abi.bytes(option, 1)[0] = retain ? 1 : 0
      abi.check(abi.call('ghostty_snapshot_decoder_set', decoder, 2, option))
      return abi.opaque((slot) => abi.call('ghostty_snapshot_decoder_decode', decoder, slot))
    } finally {
      abi.call('ghostty_snapshot_decoder_free', decoder)
    }
  } finally {
    abi.free(option, 4)
    abi.free(input, bytes.length)
  }
}

function format(abi: RexGhosttyAbi, terminal: number, extras = 0xfff): string {
  const formatter = abi.opaque((slot) =>
    abi.call('ghostty_formatter_terminal_new', 0, slot, terminal)
  )
  const option = abi.alloc(4),
    len = abi.alloc(4)
  let output = 0,
    size = 0
  try {
    // EMIT=1 (VT), TRIM=3 (false), EXTRAS=5 (caller-selected flags).
    for (const [key, value] of [
      [1, 1],
      [3, 0],
      [5, extras]
    ]) {
      abi.view().setUint32(option, value, true)
      abi.check(abi.call('ghostty_formatter_set', formatter, key, option))
    }
    const status = abi.call('ghostty_formatter_format_buf', formatter, 0, 0, len)
    if (status !== 0 && status !== -3) {
      abi.check(status)
    }
    size = abi.view().getUint32(len, true)
    if (size > REX_MAX_SNAPSHOT_BYTES) {
      throw new Error('Ghostty formatted snapshot exceeds limit')
    }
    if (!size) {
      return ''
    }
    output = abi.alloc(size)
    abi.check(abi.call('ghostty_formatter_format_buf', formatter, output, size, len))
    const written = abi.view().getUint32(len, true)
    if (written > size) {
      throw new Error('Ghostty formatter size mismatch')
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(abi.bytes(output, written))
  } finally {
    if (output) {
      abi.free(output, size)
    }
    abi.free(option, 4)
    abi.free(len, 4)
    abi.call('ghostty_formatter_free', formatter)
  }
}

function continuation(abi: RexGhosttyAbi, terminal: number): Buffer {
  const out = abi.alloc(MAX_CONTINUATION),
    len = abi.alloc(4)
  try {
    abi.check(abi.call('ghostty_terminal_continuation_buf', terminal, out, MAX_CONTINUATION, len))
    const size = abi.view().getUint32(len, true)
    if (size > MAX_CONTINUATION) {
      throw new Error('Ghostty continuation exceeds limit')
    }
    return Buffer.from(abi.bytes(out, size))
  } finally {
    abi.free(out, MAX_CONTINUATION)
    abi.free(len, 4)
  }
}

/** Run off the main thread. The verified binary has no imports and is never downloaded implicitly. */
export async function decodeRexGhosttySnapshot(
  wasm: Buffer,
  snapshot: Buffer
): Promise<RexDecodedSnapshot> {
  if (
    wasm.length > 2 * 1024 * 1024 ||
    createHash('sha256').update(wasm).digest('hex') !== REX_GHOSTTY_SHA256
  ) {
    throw new Error('Unapproved Ghostty WASM artifact')
  }
  if (snapshot.length < 10 || snapshot.length > REX_MAX_SNAPSHOT_BYTES) {
    throw new Error('Rex snapshot size unsupported')
  }
  const module = await WebAssembly.compile(Uint8Array.from(wasm))
  if (WebAssembly.Module.imports(module).length) {
    throw new Error('Unexpected Ghostty imports')
  }
  const instance = await WebAssembly.instantiate(module, {})
  const abi = new RexGhosttyAbi(instance.exports)
  const terminal = restore(abi, snapshot, true)
  try {
    // Terminal data keys: COLS=1, ROWS=2, ACTIVE_SCREEN=6.
    const cols = abi.terminalData(terminal, 1, 2),
      rows = abi.terminalData(terminal, 2, 2)
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) {
      throw new Error('Ghostty snapshot geometry unsupported')
    }
    const screen = abi.terminalData(terminal, 6, 4)
    if (screen !== 0 && screen !== 1) {
      throw new Error('Ghostty active screen unsupported')
    }
    let ansi = format(abi, terminal)
    if (screen === 1) {
      const primary = restore(abi, snapshot, false)
      const exit = Buffer.from('\x18\x1b[?1049l')
      const ptr = abi.alloc(exit.length)
      try {
        abi.bytes(ptr, exit.length).set(exit)
        abi.call('ghostty_terminal_vt_write', primary, ptr, exit.length)
        ansi = format(abi, primary) + ansi
      } finally {
        abi.free(ptr, exit.length)
        abi.call('ghostty_terminal_free', primary)
      }
    }
    if (Buffer.byteLength(ansi) > REX_MAX_SNAPSHOT_BYTES) {
      throw new Error('Ghostty combined snapshot exceeds limit')
    }
    return { ansi, cols, rows, continuation: continuation(abi, terminal) }
  } finally {
    abi.call('ghostty_terminal_free', terminal)
  }
}
