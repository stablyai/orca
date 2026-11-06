import {
  DESKTOP_PRESENCE_REPORT_INTERVAL_MS,
  NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY
} from '../../shared/desktop-client-presence'
import { getRuntimeEnvironmentStatusSnapshots } from '../ipc/runtime-environments/runtime-environment-request-connections'
import {
  listReadySharedControlSockets,
  type ReadySharedControlSocket
} from '../ipc/runtime-environments/runtime-environment-shared-control-answers'

const SAMPLE_INTERVAL_MS = 5_000
const REPORT_TIMEOUT_MS = 10_000

type Sent = { socket: string; away: boolean; at: number }

export type DesktopPresenceReporterDeps = {
  readAway: () => boolean | undefined
  listTargets: (capability: string) => ReadySharedControlSocket[]
  now?: () => number
}

/** Report desktop presence so headless hosts can honor phones’ away-only policy. */
export type DesktopPresenceReporter = {
  tick(): void
  /** Latched across ticks, so a sample between suspend and sleep cannot report present. */
  setForcedAway(forced: boolean): void
}

export function createDesktopPresenceReporter(
  deps: DesktopPresenceReporterDeps
): DesktopPresenceReporter {
  const now = deps.now ?? Date.now
  const sent = new Map<string, Sent>()
  let forcedAway = false
  const tick = (): void => {
    const targets = deps.listTargets(NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY)
    if (targets.length === 0) {
      sent.clear()
      return
    }
    // Unknown presence must not silence a phone.
    const away = forcedAway || deps.readAway() !== false
    const at = now()
    const live = new Set(targets.map((target) => target.environmentId))
    for (const environmentId of sent.keys()) {
      if (!live.has(environmentId)) {
        sent.delete(environmentId)
      }
    }
    for (const target of targets) {
      const last = sent.get(target.environmentId)
      if (
        last &&
        last.socket === target.socket &&
        last.away === away &&
        at - last.at < DESKTOP_PRESENCE_REPORT_INTERVAL_MS
      ) {
        continue
      }
      const entry = { socket: target.socket, away, at }
      sent.set(target.environmentId, entry)
      // Refused reports wait for keepalive; unsent reports retry next tick.
      void target
        .request('notifications.reportDesktopPresence', { away }, REPORT_TIMEOUT_MS)
        .catch(() => {
          if (sent.get(target.environmentId) === entry) {
            sent.delete(target.environmentId)
          }
        })
    }
  }
  return {
    tick,
    setForcedAway: (forced) => {
      forcedAway = forced
      tick()
    }
  }
}

export function listCapableSharedControlSockets(capability: string): ReadySharedControlSocket[] {
  const capable = new Set(
    getRuntimeEnvironmentStatusSnapshots()
      .filter((snapshot) => snapshot.status?.capabilities?.includes(capability))
      .map((snapshot) => snapshot.environmentId)
  )
  return listReadySharedControlSockets().filter((target) => capable.has(target.environmentId))
}

export function startDesktopPresenceReporter(
  deps: DesktopPresenceReporterDeps & {
    /** Hold away through sleep/lock until resume/unlock. */
    subscribePowerEvents: (handlers: { away: () => void; back: () => void }) => () => void
  }
): () => void {
  const reporter = createDesktopPresenceReporter(deps)
  const timer = setInterval(reporter.tick, SAMPLE_INTERVAL_MS)
  timer.unref?.()
  const unsubscribe = deps.subscribePowerEvents({
    away: () => reporter.setForcedAway(true),
    back: () => reporter.setForcedAway(false)
  })
  return () => {
    clearInterval(timer)
    unsubscribe()
  }
}
