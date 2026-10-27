import { SERVE_SUPERVISOR_HEARTBEAT_MS } from '../../shared/serve-bundle-coordination'
import type { ServeBundlePark } from '../../shared/serve-bundle-park'

export const SERVE_PARK_POLL_MS = 1_000

type ServeChild = { pid: number | null; stop: () => void } | null

export type SupervisedParkWatch = {
  /** Between attempts: no server runs, so a pending park is acknowledged at once. True = hold. */
  idle: () => boolean
  /** Runs one attempt; stops its server when the desktop asks to park, and acknowledges after. */
  during: (
    run: () => Promise<number>
  ) => Promise<{ parked: boolean; settled: PromiseSettledResult<number> }>
  close: () => void
}

export function createSupervisedParkWatch(
  park: ServeBundlePark,
  deps: {
    currentChild: () => ServeChild
    setRepeating: (callback: () => void, ms: number) => () => void
    now: () => number
  }
): SupervisedParkWatch {
  const acked = new Set<string>()
  let lastBeat: { pid: number | null | undefined; at: number } = { pid: undefined, at: 0 }
  const beat = (pid: number | null): void => {
    if (pid !== lastBeat.pid || deps.now() - lastBeat.at >= SERVE_SUPERVISOR_HEARTBEAT_MS) {
      park.heartbeat(pid)
      lastBeat = { pid, at: deps.now() }
    }
  }
  const ack = (attemptId: string): void => {
    if (!acked.has(attemptId)) {
      acked.add(attemptId)
      park.ack(attemptId)
    }
  }
  return {
    idle: () => {
      beat(null)
      const pending = park.pendingPark()
      if (pending) {
        ack(pending.attemptId)
      }
      return park.holds()
    },
    during: async (run) => {
      let parking: string | null = null
      let holding = false
      let stoppedPid: number | null = null
      const tick = (): void => {
        const child = deps.currentChild()
        beat(child?.pid ?? null)
        if (parking === null) {
          const pending = park.pendingPark()
          parking = pending && !acked.has(pending.attemptId) ? pending.attemptId : null
        }
        // Why holds() too: a server another profile's supervisor started mid-install is not listed.
        holding = holding || park.holds()
        // Why per pid: a park can land between preflight and spawn, before any child exists.
        if ((parking !== null || holding) && child && child.pid !== stoppedPid) {
          stoppedPid = child.pid
          child.stop()
        }
      }
      const cancel = deps.setRepeating(tick, SERVE_PARK_POLL_MS)
      let settled: PromiseSettledResult<number>
      try {
        settled = { status: 'fulfilled', value: await run() }
      } catch (reason) {
        settled = { status: 'rejected', reason }
      } finally {
        cancel()
      }
      if (parking !== null) {
        ack(parking)
        return { parked: true, settled }
      }
      // A first spawn refused by the hold, or a server stopped for it, is not a failure either.
      return { parked: holding || park.holds(), settled }
    },
    close: () => park.unregister()
  }
}
