/**
 * Timing probes for the terminal latency harness (`mobile/scripts/terminal-latency/`).
 *
 * Off unless the app is built with `EXPO_PUBLIC_ORCA_TERMINAL_LATENCY_PROBES=1`. When on, each
 * event prints one `[lat] <kind> <phone clock ms> ...` line, which Metro forwards and the harness
 * reads. The phone's own clock is what makes key-to-echo and touch-to-draw measurable from
 * outside without a host or network timestamp.
 *
 * Kinds: `key` (the live input's text changed; the line carries the whole field text, so one
 * line per keystroke while typing), `tx`/`ack`/`nak` (a terminal.send left and was answered),
 * `touchstart`/`touchend` (on the terminal surface), `rx` (the screen changed after a drained
 * write; the document reports it).
 */
export const TERMINAL_LATENCY_PROBES = process.env.EXPO_PUBLIC_ORCA_TERMINAL_LATENCY_PROBES === '1'

export function reportTerminalLatencyProbe(kind: string, detail = ''): void {
  if (TERMINAL_LATENCY_PROBES) {
    console.log(`[lat] ${kind} ${Date.now()}${detail ? ` ${detail}` : ''}`)
  }
}

/** Stamps a `terminal.send` as it leaves and as it is answered; other methods pass through. */
export function probeTerminalSend<T>(
  method: string,
  params: unknown,
  reply: Promise<T>
): Promise<T> {
  if (!TERMINAL_LATENCY_PROBES || method !== 'terminal.send') {
    return reply
  }
  const sentAt = Date.now()
  const text =
    typeof params === 'object' && params !== null && 'text' in params
      ? JSON.stringify(params.text)
      : ''
  reportTerminalLatencyProbe('tx', `n=${text.length} ${text.slice(0, 80)}`)
  void reply.then(
    () => reportTerminalLatencyProbe('ack', `sent=${sentAt}`),
    () => reportTerminalLatencyProbe('nak', `sent=${sentAt}`)
  )
  return reply
}

/** The document's own probe messages, relayed with the phone-side timestamp the document took. */
export function relayTerminalDocumentLatencyProbe(msg: Record<string, unknown>): boolean {
  if (!TERMINAL_LATENCY_PROBES || typeof msg.t !== 'number') {
    return false
  }
  if (msg.type === 'latency-touch') {
    console.log(`[lat] ${String(msg.phase)} ${msg.t}`)
    return true
  }
  if (msg.type === 'latency-screen') {
    console.log(
      `[lat] rx ${msg.t} top=${String(msg.top)} bot=${String(msg.bot)} alt=${String(msg.alt)} zq=${String(msg.zq)}`
    )
    return true
  }
  return false
}
