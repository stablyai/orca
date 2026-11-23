// Wake alert rules over per-window counts of the wake dataset (metrics.ts events; alerts.ts reads
// them). Messages carry counts and shares only, never a host or account id.
import { thresholds as edgeThresholds, type AlertsEnv, type Counts, type Thresholds } from '../../relay-edge/src/alerts-rules'

export type { Counts }

export type WakeAlertsEnv = AlertsEnv & {
  // no-socket-share fires above NO_SOCKET_PCT (5) percent of wakes, at >= NO_SOCKET_MIN (50) wakes.
  NO_SOCKET_PCT?: string
  NO_SOCKET_MIN?: string
  // Comma-separated rule ids this deployment never evaluates (e.g. 'silent' where no clients run).
  ALERTS_OFF?: string
  // Which rules are firing and when each was last posted (alerts.ts). Unbound: every breaching run posts.
  ALERT_STATE?: KVNamespace
}

export type WakeThresholds = Thresholds & { noSocketPct: number; noSocketMin: number; probesPerWindow: number }

export const WINDOW_MIN = 15
// The cron runs every 5 min, and each run's edge probe is one refused upgrade (refuse 401 'token').
// Cron jitter can put one more probe than WINDOW_MIN / PROBE_EVERY_MIN inside a window.
const PROBE_EVERY_MIN = 5
const ADMIN_FAILURES_MIN = 3
const WAKE_ERRORS_MIN = 3
const LOW_VOLUME_401_MIN = 5

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function thresholds(env: WakeAlertsEnv): WakeThresholds {
  return {
    ...edgeThresholds(env),
    noSocketPct: positive(env.NO_SOCKET_PCT, 5),
    noSocketMin: positive(env.NO_SOCKET_MIN, 50),
    probesPerWindow: env.EDGE_PROBE_URL ? WINDOW_MIN / PROBE_EVERY_MIN + 1 : 0
  }
}

// Each column the SQL sums per minute, weighted by Analytics Engine sampling. blobs: [event, label,
// version, reason, place]; double1 is the event's value (a wake event's value is its host count).
export const COLUMNS = {
  socket_open: "sumIf(_sample_interval, blob1 = 'socket_open')",
  refuse_401: "sumIf(_sample_interval, blob1 = 'refuse' AND blob4 = 'token')",
  refuse_country: "sumIf(_sample_interval, blob1 = 'refuse' AND blob4 = 'country')",
  keys_unavailable: "sumIf(_sample_interval, blob1 = 'upgrade' AND blob2 = 'keys_unavailable')",
  admin_failures: "sumIf(_sample_interval, blob1 = 'admin' AND blob2 != '200')",
  wakes: "sumIf(_sample_interval * double1, blob1 = 'wake')",
  wake_no_socket: "sumIf(_sample_interval * double1, blob1 = 'wake' AND blob2 = 'no_socket')",
  wake_error: "sumIf(_sample_interval * double1, blob1 = 'wake' AND blob2 = 'error')",
  events: "sumIf(_sample_interval, blob1 != 'refuse')"
} as const

// Counts per whole minute before atSec (0 = the last minute), so one query gives both windows.
// atSec is the run's scheduled time, never the query's NOW().
export const SQL = (dataset: string, fromMin: number, atSec: number) => `
SELECT
  intDiv(${atSec} - toUInt32(timestamp), 60) AS ago,
${Object.entries(COLUMNS).map(([name, sum]) => `  ${sum} AS ${name}`).join(',\n')}
FROM ${dataset}
WHERE timestamp > toDateTime(${atSec - fromMin * 60}) AND timestamp <= toDateTime(${atSec})
GROUP BY ago
FORMAT JSON`

export type Rule = { id: string; describe: (now: Counts, t: WakeThresholds) => string; breach: (c: Counts, t: WakeThresholds, prior?: Counts) => boolean }

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : 0)
// Every upgrade that reached the token check or the country check.
const upgrades = (c: Counts) => c.socket_open + c.refuse_401 + c.refuse_country + c.keys_unavailable
// Refusals other than the alerts' own probes.
const refusals401 = (c: Counts, t: WakeThresholds) => Math.max(0, c.refuse_401 - t.probesPerWindow)

export const RULES: Rule[] = [
  {
    // A desktop refused at upgrade falls back to long-poll; a spike means good tokens are refused.
    id: 'auth-refusals',
    breach: (c, t) => upgrades(c) >= t.minVolume && pct(refusals401(c, t), upgrades(c)) > 0.5,
    describe: (c, t) => `401 refusals ${refusals401(c, t)} = ${pct(refusals401(c, t), upgrades(c)).toFixed(2)}% of upgrades`
  },
  {
    // Below the share rules' volume a handful of 401s is still worth a look.
    id: 'auth-refusals-low-volume',
    breach: (c, t) => upgrades(c) < t.minVolume && refusals401(c, t) >= LOW_VOLUME_401_MIN,
    describe: (c, t) => `401 refusals ${refusals401(c, t)} in ${WINDOW_MIN} min at low volume (${upgrades(c)} upgrades)`
  },
  {
    // Sockets dropped en masse (deploy, eviction, runtime restart): the desktops reconnect at once.
    id: 'reconnect-surge',
    breach: (c, t, prior) => prior !== undefined && c.socket_open >= Math.max(3 * prior.socket_open, t.surgeMin),
    describe: (c) => `socket opens ${c.socket_open} in ${WINDOW_MIN} min, at least 3x the previous window`
  },
  {
    // The connector's publisher calls refused: its key, issuer or body is wrong.
    id: 'admin-failures',
    breach: (c) => c.admin_failures >= ADMIN_FAILURES_MIN,
    describe: (c) => `${c.admin_failures} failed admin calls in ${WINDOW_MIN} min`
  },
  {
    // A wake that reached an object but failed there (its socket send threw, or the call failed).
    // The object catches it, so Cloudflare's error counts never see it.
    id: 'wake-errors',
    breach: (c) => c.wake_error >= WAKE_ERRORS_MIN,
    describe: (c) => `${c.wake_error} wakes failed in ${WINDOW_MIN} min, of ${c.wakes} wakes`
  },
  {
    // Wakes for hosts the connector believes are on wake that have no socket here. Hosts in refused
    // countries are always no_socket and the dataset cannot tell them apart (their wake reaches an
    // object no socket ever reached), so NO_SOCKET_PCT must sit above their share of the cohort.
    id: 'no-socket-share',
    breach: (c, t) => c.wakes >= t.noSocketMin && pct(c.wake_no_socket, c.wakes) > t.noSocketPct,
    describe: (c) => `wakes with no socket ${c.wake_no_socket} = ${pct(c.wake_no_socket, c.wakes).toFixed(1)}% of ${c.wakes} wakes`
  },
  {
    // Dead man: sockets, wakes and admin calls stopped after a window that had some. Refusals are
    // left out, so the alerts' own probes never keep it quiet.
    id: 'silent',
    breach: (c, t, prior) => prior !== undefined && prior.events >= t.minVolume && c.events === 0,
    describe: () => `no wake events in ${WINDOW_MIN} min`
  },
  {
    // Worker / Durable Object invocations that ended in an error (Cloudflare GraphQL; never breaching
    // when no token reads it).
    id: 'cloudflare-errors',
    breach: (c, t) => (c.cf_errors ?? 0) > t.cfErrorsMin && pct(c.cf_errors ?? 0, c.cf_invocations ?? 0) > t.cfErrorsPct,
    describe: (c) => `Worker/Durable Object errors ${c.cf_errors} = ${pct(c.cf_errors ?? 0, c.cf_invocations ?? 0).toFixed(1)}% of ${c.cf_invocations} invocations in ${WINDOW_MIN} min`
  }
]
