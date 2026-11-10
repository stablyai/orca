// Tells someone using a forwarded connection apart from the protocol keeping it open, from the
// bytes this computer sends to the host. Feeds idle sleep for cloud VMs, so it must let an editor
// window nobody touches sleep while typing keeps the VM awake.
//
// Measured on a real VM (W3 perf, OpenSSH 10 client, openvscode-server 1.109 over `ssh -L`, bytes
// the forward carried toward the VM):
// - idle `ssh -N` or an idle shell: one 52 B keepalive every 30 s, ~104 B/min.
// - idle VS Code remote window: a 60 + 44 + 52 B burst every 5 s, 2.3-3.0 KB/min, at most 5
//   packets in any 2 s. That was above the old 2 KiB/min bar, so an open editor kept the VM awake.
// - typing in a shell: 36 B packets every ~21 ms (OpenSSH's keystroke-timing chaff), ~95 KB/min.
// - typing in the editor: ~60 KB/min, up to 32 packets in 2 s; one short line typed and saved
//   once a minute: ~5 KB/min, 26 packets of 44-124 B within 1.7 s.
// Keepalives stay small and evenly spaced; use is a burst of packets or larger ones.

/** Sliding window the thresholds below apply to. */
export const FORWARD_USE_WINDOW_MS = 10_000
/** Packets up to this size are keepalive-sized; alone they count only through their rate. */
export const FORWARD_USE_SMALL_CHUNK_BYTES = 128
/** Bytes in larger packets within one window that mean use (an idle VS Code window sends none). */
export const FORWARD_USE_PAYLOAD_BYTES = 1024
/** Packets of any size within one window that mean use (an idle VS Code window sends ~6). */
export const FORWARD_USE_CHUNKS = 40
/** A short burst of packets that means use: typing, even one short line. */
export const FORWARD_USE_BURST_MS = 2_000
export const FORWARD_USE_BURST_CHUNKS = 10

/** One connection's client-to-host traffic. Holds at most FORWARD_USE_CHUNKS entries. */
export class ForwardUseMeter {
  private readonly chunks: { at: number; bytes: number }[] = []
  private payloadBytes = 0

  /** Records one chunk sent to the host; true when the window now shows someone using it. */
  note(at: number, bytes: number): boolean {
    if (bytes <= 0) {
      return false
    }
    const windowStart = at - FORWARD_USE_WINDOW_MS
    while (this.chunks.length > 0 && this.chunks[0]!.at <= windowStart) {
      const old = this.chunks.shift()!
      if (old.bytes > FORWARD_USE_SMALL_CHUNK_BYTES) {
        this.payloadBytes -= old.bytes
      }
    }
    this.chunks.push({ at, bytes })
    if (bytes > FORWARD_USE_SMALL_CHUNK_BYTES) {
      this.payloadBytes += bytes
    }
    if (
      this.payloadBytes < FORWARD_USE_PAYLOAD_BYTES &&
      this.chunks.length < FORWARD_USE_CHUNKS &&
      !this.burstEndsAt(at)
    ) {
      return false
    }
    // Start the next window empty: memory stays bounded however fast the client sends.
    this.chunks.length = 0
    this.payloadBytes = 0
    return true
  }

  private burstEndsAt(at: number): boolean {
    const first = this.chunks.length - FORWARD_USE_BURST_CHUNKS
    return first >= 0 && at - this.chunks[first]!.at < FORWARD_USE_BURST_MS
  }
}
