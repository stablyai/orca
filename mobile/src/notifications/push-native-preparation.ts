import { ensureDesktopNotificationChannel } from './desktop-notification-channel'
import { getDevicePushToken, type MobilePushToken } from './push-token'

type TokenResult =
  | { status: 'ready'; token: MobilePushToken }
  | { status: 'unavailable' }
  | { status: 'retired' }
export type TokenPreparation = { readonly result: Promise<TokenResult>; release(): void }
type Assignment = { current?: () => boolean; accept?: (token: MobilePushToken | null) => void }
type Entry = {
  current?: () => boolean
  token?: () => MobilePushToken | null
  resolve?: (result: TokenResult) => void
  timer?: ReturnType<typeof setTimeout>
}
const entries = new Set<Entry>()
let selected: Assignment | undefined
let physical: { observation?: object } | undefined
let observation: object = {}

function releaseAssignment(cell: Assignment): void {
  if (selected === cell) {
    selected = undefined
  }
  cell.current = undefined
  cell.accept = undefined
}
function assignmentCurrent(): boolean {
  if (selected && !selected.current?.()) {
    releaseAssignment(selected)
  }
  return selected !== undefined
}
function complete(entry: Entry, result: TokenResult): void {
  entries.delete(entry)
  clearTimeout(entry.timer)
  const resolve = entry.resolve
  entry.current = undefined
  entry.token = undefined
  entry.resolve = undefined
  entry.timer = undefined
  resolve?.(result)
}
export function settleTokenPreparations(finished = false): void {
  for (const entry of entries) {
    if (!entry.current?.()) {
      complete(entry, { status: 'retired' })
    } else {
      const token = entry.token?.()
      if (token) {
        complete(entry, { status: 'ready', token })
      } else if (finished) {
        complete(entry, { status: 'unavailable' })
      }
    }
  }
}
export function observeNativePushToken(): void {
  observation = {}
  if (selected) {
    releaseAssignment(selected)
  }
}
async function run(phase: NonNullable<typeof physical>): Promise<void> {
  let token: MobilePushToken | null = null
  try {
    if (!assignmentCurrent()) {
      return
    }
    await ensureDesktopNotificationChannel()
    if (!assignmentCurrent()) {
      return
    }
    phase.observation = observation
    token = await getDevicePushToken()
  } catch {
    // A finite source failure ends this attempt; only a genuine demand admits another.
  } finally {
    if (physical === phase) {
      physical = undefined
      if (
        (!phase.observation || phase.observation === observation) &&
        assignmentCurrent() &&
        selected
      ) {
        const cell = selected
        const accept = cell.accept
        releaseAssignment(cell)
        accept?.(token)
      } else if (phase.observation && phase.observation !== observation && assignmentCurrent()) {
        start()
      }
      settleTokenPreparations(!physical)
    }
  }
}
function start(): void {
  if (!physical && assignmentCurrent()) {
    const phase = {}
    physical = phase
    void run(phase)
  }
}
export function qualifyNativePushToken(
  current: () => boolean,
  accept: (token: MobilePushToken | null) => void,
  mayStart: boolean
): (() => void) | undefined {
  if (selected) {
    releaseAssignment(selected)
  }
  const cell: Assignment = { current, accept }
  if (mayStart || physical) {
    selected = cell
    if (mayStart) {
      start()
    }
  } else {
    releaseAssignment(cell)
    return undefined
  }
  return () => releaseAssignment(cell)
}
export function prepareNativePushToken(
  current: () => boolean,
  token: () => MobilePushToken | null
): TokenPreparation {
  const own = Promise.withResolvers<TokenResult>()
  const entry: Entry = { current, token, resolve: own.resolve }
  entries.add(entry)
  settleTokenPreparations(!physical)
  if (entries.has(entry)) {
    entry.timer = setTimeout(() => complete(entry, { status: 'unavailable' }), 2000)
  }
  return { result: own.promise, release: () => complete(entry, { status: 'retired' }) }
}
export function pushNativeSnapshotForTests() {
  return {
    physical: Number(physical !== undefined),
    assignment: Number(selected !== undefined),
    entries: entries.size,
    timers: [...entries].filter((entry) => entry.timer !== undefined).length,
    callables:
      [...entries].reduce(
        (n, entry) => n + Number(!!entry.current) + Number(!!entry.token) + Number(!!entry.resolve),
        0
      ) +
      Number(!!selected?.current) +
      Number(!!selected?.accept)
  }
}
