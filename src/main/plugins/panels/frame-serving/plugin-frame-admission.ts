import { PrioritySemaphore } from '../../../../shared/concurrency/priority-semaphore'

/** Buffered requests one guest session serves at once; more wait for a free slot. */
export const PLUGIN_FRAME_MAX_IN_FLIGHT = 32
/** Buffered requests one guest session may have waiting for a slot; more get 503. */
export const PLUGIN_FRAME_MAX_QUEUED = 1024
/** How long a buffered request waits for a slot before it gets 503. */
export const PLUGIN_FRAME_MAX_WAIT_MS = 10_000
/** Streamed bodies one guest session may hold open; more get 503 at once. */
export const PLUGIN_FRAME_MAX_STREAMS = 32

type PluginFrameAdmission =
  | { release: () => void }
  /** `firstInBurst`: log this one; its lane has refused nothing since it last drained. */
  | { refused: string; firstInBurst: boolean }

type AdmissionLane = { open: number; busyLogged: boolean }

/**
 * One guest session's request slots. Why caps: each request may hold a file in memory or an open
 * stream until it completes. Why buffered requests queue: a refused import fails the frame's whole
 * module graph. Why streams refuse at once: Chromium may leave media bodies unread, holding their
 * slot, so they get their own cap and never fill the slots buffered requests wait for.
 */
export function createPluginFrameAdmission(): (streamed: boolean) => Promise<PluginFrameAdmission> {
  const slots = new PrioritySemaphore(PLUGIN_FRAME_MAX_IN_FLIGHT)
  // Why per lane: a stream left open must not silence later buffered refusals for the session.
  const buffered: AdmissionLane = { open: 0, busyLogged: false }
  const streams: AdmissionLane = { open: 0, busyLogged: false }
  // Why once per burst: a saturated lane refuses every request, which would flood the log.
  const refuse = (lane: AdmissionLane, reason: string): PluginFrameAdmission => {
    const firstInBurst = !lane.busyLogged
    lane.busyLogged = true
    return { refused: reason, firstInBurst }
  }
  const admitted = (lane: AdmissionLane, freeSlot?: () => void): PluginFrameAdmission => {
    let released = false
    return {
      release: () => {
        if (!released) {
          released = true
          lane.open -= 1
          freeSlot?.()
          if (lane.open === 0) {
            lane.busyLogged = false
          }
        }
      }
    }
  }
  return async (streamed) => {
    if (streamed) {
      if (streams.open >= PLUGIN_FRAME_MAX_STREAMS) {
        return refuse(streams, `more than ${PLUGIN_FRAME_MAX_STREAMS} streams open`)
      }
      streams.open += 1
      return admitted(streams)
    }
    if (buffered.open >= PLUGIN_FRAME_MAX_IN_FLIGHT + PLUGIN_FRAME_MAX_QUEUED) {
      return refuse(
        buffered,
        `more than ${PLUGIN_FRAME_MAX_IN_FLIGHT + PLUGIN_FRAME_MAX_QUEUED} requests open`
      )
    }
    buffered.open += 1
    const waited = new AbortController()
    const timer = setTimeout(() => waited.abort(), PLUGIN_FRAME_MAX_WAIT_MS)
    const releaseSlot = await slots.acquire(0, waited.signal).catch(() => null)
    clearTimeout(timer)
    if (!releaseSlot) {
      buffered.open -= 1
      return refuse(
        buffered,
        `waited ${PLUGIN_FRAME_MAX_WAIT_MS} ms for one of ${PLUGIN_FRAME_MAX_IN_FLIGHT} request slots`
      )
    }
    return admitted(buffered, releaseSlot)
  }
}
