import { RELAY_WRITE_CHUNK_CHARS } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { RelayedProviderOutput } from './relayed-provider-output'

export type RelayState = 'attaching' | 'attached' | 'reattaching' | 'detached' | 'exited'

/** The daemon's refusal of input past its queue cap. */
const RELAY_INPUT_FULL = 'Relay input is full'

const FIRST_RETRY_MS = 50
const MAX_RETRY_MS = 2_000

/** Refused input is offered again after a wait that doubles, up to 2 s, while the agent isn't reading. */
class RelayInputBackoff {
  private nextMs = FIRST_RETRY_MS

  wait(): Promise<void> {
    const ms = this.nextMs
    this.nextMs = Math.min(ms * 2, MAX_RETRY_MS)
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/** What a relayed child's input needs of it: its state, its attach in flight, and the daemon write. */
export type RelayedInputTarget = {
  state: () => RelayState
  ready: () => Promise<unknown>
  reattached: () => Promise<void>
  write: (data: string) => Promise<unknown>
}

/** Writes once attached; a full queue backs off, an attach in flight is waited on, never spun on. */
export async function sendRelayedInput(target: RelayedInputTarget, data: string): Promise<void> {
  const backoff = new RelayInputBackoff()
  for (;;) {
    const state = target.state()
    if (state === 'detached') {
      return
    }
    if (state === 'exited') {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    }
    try {
      await target.write(data)
      return
    } catch (error) {
      if (error instanceof Error && error.message.includes(RELAY_INPUT_FULL)) {
        await backoff.wait()
        continue
      }
      const waiting = target.reattached()
      if (state === 'reattaching' || state === 'attaching') {
        await Promise.all([target.ready().catch(() => {}), waiting])
        // Settled but still not attached (an exit parked behind held output): fail, never spin.
        if (target.state() === 'attached' || target.reattached() !== waiting) {
          continue
        }
      }
      throw error
    }
  }
}

/** A write's stdin chunks, read now and sent after `after` in the daemon's slices (it joins a
 *  surrogate pair split between them). */
export function sendRelayedChunks(
  chunks: unknown[],
  after: Promise<void>,
  send: (slice: string) => Promise<void>
): Promise<void> {
  const data = chunks
    .map((chunk) => (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)))
    .join('')
  return after.then(async () => {
    for (let at = 0; at < data.length; at += RELAY_WRITE_CHUNK_CHARS) {
      await send(data.slice(at, at + RELAY_WRITE_CHUNK_CHARS))
    }
  })
}

/** After an agent's exit: the final output is acked so the daemon can drop the ended relay, and
 *  then nothing more is read. */
export function letGoOfExitedRelay(
  output: Pick<RelayedProviderOutput, 'settle' | 'stop'>,
  unbind: () => void
): Promise<void> {
  return output.settle().finally(() => {
    output.stop()
    unbind()
  })
}
