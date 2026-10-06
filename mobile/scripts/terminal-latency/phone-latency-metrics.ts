/**
 * Turns one recorded scenario (the phone's probe lines) into numbers.
 *
 * Probe lines, all stamped with the phone's clock in ms:
 *   key <t> "<text>"      the live input changed; <text> is the whole field, one line per key
 *   tx <t> n=<len> <text> a terminal.send left the app;  ack <t> sent=<t> its reply came back
 *   rx <t> top=L.. bot=L.. alt=.. zq=<text>   the screen changed: first and last line markers
 *                         shown, and the typed line as echoed
 *   touchstart <t> / touchend <t>
 */
export type ScenarioRecord = {
  label: string
  profile: string
  run: number
  tab: string
  scenario: string
  text?: string
  startedAt?: number
  cut?: { from: number; to: number } | null
  finished?: boolean
  events: string[]
}

export type Metrics = Record<string, number>

type Screen = { at: number; top: number | null; bot: number | null; echoed: string }

const marker = (field: string | undefined): number | null => {
  const digits = field?.match(/L(\d{3,6})/)
  return digits ? Number(digits[1]) : null
}

function screens(events: string[]): Screen[] {
  return events
    .filter((line) => line.startsWith('rx '))
    .map((line) => {
      const parts = line.split(' ')
      return {
        at: Number(parts[1]),
        top: marker(parts.find((part) => part.startsWith('top='))),
        bot: marker(parts.find((part) => part.startsWith('bot='))),
        echoed: line.slice(line.indexOf(' zq=') + 4)
      }
    })
}

const times = (events: string[], kind: string): number[] =>
  events.filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.split(' ')[1]))

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

/** Key press to the moment the screen shows that character. */
function typing(record: ScenarioRecord): Metrics {
  const text = record.text ?? ''
  const keys = record.events
    .filter((line) => /^key \d+ "/.test(line))
    .map((line) => Number(line.split(' ')[1]))
  const shown = screens(record.events)
  const delays: number[] = []
  let lost = 0
  // Why skip two: the screen only identifies the line once its "zq" prefix is there.
  for (let index = 2; index < text.length && index < keys.length; index++) {
    const prefix = text.slice(0, index + 1)
    const echo = shown.find(
      (screen) => screen.at >= keys[index] && screen.echoed.startsWith(prefix)
    )
    if (echo) {
      delays.push(echo.at - keys[index])
    } else {
      lost++
    }
  }
  // Why valid even with nothing echoed: a run that lost every key is the metric's worst case,
  // and it must count in `keysLost` rather than vanish from the table.
  const metrics: Metrics = { valid: 1, keysLost: lost, sends: times(record.events, 'tx').length }
  if (delays.length > 0) {
    metrics.echoP50Ms = percentile(delays, 0.5)
    metrics.echoP95Ms = percentile(delays, 0.95)
    metrics.echoMaxMs = Math.max(...delays)
  }
  return metrics
}

/** Watching an answer stream in: how long until it starts, and how long the screen freezes. */
function stream(record: ScenarioRecord): Metrics {
  const startedAt = record.startedAt ?? 0
  const at = screens(record.events)
    .map((screen) => screen.at)
    .filter((time) => time >= startedAt)
  if (at.length < 2) {
    return { valid: 0, finished: record.finished ? 1 : 0 }
  }
  const gaps = at.slice(1).map((time, index) => time - at[index])
  const metrics: Metrics = {
    valid: 1,
    finished: record.finished ? 1 : 0,
    firstOutputMs: at[0] - startedAt,
    durationMs: at.at(-1)! - startedAt,
    freezeP95Ms: percentile(gaps, 0.95),
    freezeMaxMs: Math.max(...gaps)
  }
  if (record.cut) {
    const after = at.find((time) => time >= record.cut!.to)
    metrics.cutMs = record.cut.to - record.cut.from
    metrics.resumeAfterCutMs = after === undefined ? Number.NaN : after - record.cut.to
  }
  return metrics
}

/** A swipe: how many separate positions the phone drew, how far it jumped, when it settled. */
function swipe(record: ScenarioRecord): Metrics {
  const starts = times(record.events, 'touchstart')
  const ends = times(record.events, 'touchend')
  if (starts.length === 0 || ends.length === 0) {
    return { valid: 0 }
  }
  const shown = screens(record.events).filter((screen) => screen.at >= starts[0])
  const tops = shown.filter((screen) => screen.top !== null)
  const jumps = tops
    .slice(1)
    .map((screen, index) => Math.abs(screen.top! - tops[index].top!))
    .filter((rows) => rows > 0)
  const sends = record.events.filter((line) => line.startsWith('tx '))
  const metrics: Metrics = {
    valid: 1,
    positionsDrawn: jumps.length,
    rowsMoved: jumps.reduce((sum, rows) => sum + rows, 0),
    largestJumpRows: jumps.length ? Math.max(...jumps) : 0,
    settleMs: shown.length ? Math.max(0, shown.at(-1)!.at - ends[0]) : Number.NaN,
    firstMoveMs: shown.length ? shown[0].at - starts[0] : Number.NaN,
    sends: sends.length
  }
  if (record.scenario === 'drag-then-tap' && starts.length > 1) {
    // A tap on a mouse-tracking program is sent as a button-0 press.
    const tapSent = sends.some(
      (line) => Number(line.split(' ')[1]) >= starts[1] && line.includes('[<0;')
    )
    metrics.tapDelivered = tapSent ? 1 : 0
  }
  return metrics
}

export function scenarioMetrics(record: ScenarioRecord): Metrics {
  if (record.scenario === 'type') {
    return typing(record)
  }
  if (record.scenario === 'stream') {
    return stream(record)
  }
  return swipe(record)
}
