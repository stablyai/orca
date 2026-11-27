// Test streams for one-link fault tests: a credit-windowed binary burst like a chatty terminal's,
// with an owner that reopens it when it ends with its socket, and a JSON tick stream.
import { z } from 'zod'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import { defineStreamingMethod } from '../core'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

export const FRAME_BYTES = 16 * 1024
// Like a terminal stream's ack window: the host sends at most this far ahead of the client's acks.
const WINDOW_BYTES = 256 * 1024

// Bursts running on the host, by tag.
export const runningBursts = new Map<number, number>()

// A burst like a chatty terminal's: tagged frames as fast as the client's acks allow.
export const burst = defineStreamingMethod({
  name: 'test.burst',
  permission: 'workspace',
  share: 'not-shared',
  params: lazyZodSchema(() => z.object({ tag: z.number().int() })),
  handler: ({ tag }, { sendBinary, registerBinaryMessageHandler, signal }, emit) =>
    new Promise<void>((resolve) => {
      let inFlight = 0
      let seq = 0
      let wake: (() => void) | null = null
      runningBursts.set(tag, (runningBursts.get(tag) ?? 0) + 1)
      registerBinaryMessageHandler?.((bytes) => {
        inFlight -= bytes[1] * FRAME_BYTES
        wake?.()
      })
      signal?.addEventListener('abort', () => {
        runningBursts.set(tag, runningBursts.get(tag)! - 1)
        wake?.()
        resolve()
      })
      emit({ type: 'ready' })
      void (async () => {
        while (!signal?.aborted) {
          if (inFlight + FRAME_BYTES > WINDOW_BYTES) {
            await new Promise<void>((next) => (wake = next))
            wake = null
            continue
          }
          const frame = new Uint8Array(FRAME_BYTES)
          frame[0] = tag
          new DataView(frame.buffer).setUint32(1, ++seq, true)
          inFlight += FRAME_BYTES
          sendBinary?.(frame)
          await new Promise((next) => setImmediate(next))
        }
      })()
    })
})
export const ticks = defineStreamingMethod({
  name: 'test.ticks',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: (_params, { signal }, emit) =>
    new Promise<void>((resolve) => {
      let tick = 0
      const timer = setInterval(() => emit({ tick: ++tick }), 50)
      signal?.addEventListener('abort', () => {
        clearInterval(timer)
        resolve()
      })
    })
})
export type BurstStream = {
  tag: number
  frames: number
  wrong: number
  ends: number
  close: () => void
}

// Like a terminal pane's owner: a stream that ends with its socket is opened again.
export async function openBurst(
  connection: Parameters<typeof subscribeRemoteRuntimeTransport>[0],
  tag: number,
  cleanups: (() => Promise<void> | void)[]
): Promise<BurstStream> {
  const stream: BurstStream = { tag, frames: 0, wrong: 0, ends: 0, close: () => {} }
  let closedByOwner = false
  const open = async (): Promise<void> => {
    let ack: (bytes: Uint8Array) => boolean = () => false
    const subscription = await subscribeRemoteRuntimeTransport(
      connection,
      'test.burst',
      { tag },
      20_000,
      {
        onResponse: () => {},
        onBinary: (bytes) => {
          if (bytes[0] === tag && bytes.byteLength === FRAME_BYTES) {
            stream.frames += 1
          } else {
            stream.wrong += 1
          }
          ack(Uint8Array.of(tag, 1))
        },
        onError: () => {},
        onClose: () => {
          stream.ends += 1
          if (!closedByOwner) {
            // A reopen racing teardown fails like any failed open; the owner just stops.
            void open().catch(() => {})
          }
        }
      }
    )
    ack = subscription.sendBinary
    stream.close = () => {
      closedByOwner = true
      subscription.close()
    }
  }
  await open()
  // Owners close their streams before the link and cell go, as a closing pane does.
  cleanups.push(() => stream.close())
  return stream
}
