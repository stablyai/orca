import {
  MACHINE_FIELDS,
  SNAPSHOT_FIELDS,
  type HangPowerReceipt,
  type CompletedHangContext,
  type HangObservation,
  type HangObservationCollection,
  type HangDetectionMarker
} from './hang-observation-schema'
import {
  admitHangObservation,
  parseMainJsCapture,
  parseNativeHangCapture
} from './hang-capture-codec'
export { MACHINE_FIELDS, SNAPSHOT_FIELDS } from './hang-observation-schema'
export type {
  HangSnapshot,
  HangMachineSnapshot,
  HangPowerReceipt,
  CompletedHangContext,
  HangObservation,
  HangObservationCollection,
  HangDetectionMarker
} from './hang-observation-schema'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the branch excludes null, primitives and arrays before reading unknown properties.
      (value as Record<string, unknown>)
    : null
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function numericFields<K extends string>(
  value: unknown,
  keys: readonly K[]
): Record<K, number | null> | null {
  const data = object(value)
  if (!data) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every supplied key is emitted once with a finite number or null.
  return Object.fromEntries(
    keys.map((key) => [key, finite(data[key]) ? data[key] : null])
  ) as Record<K, number | null>
}
export function parsePowerReceipt(value: unknown): HangPowerReceipt | null {
  const data = object(value)
  if (
    !data ||
    !['suspend', 'resume', 'lock-screen', 'unlock-screen'].includes(String(data.event)) ||
    !finite(data.observedAt) ||
    !finite(data.receivedAt)
  ) {
    return null
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed event allowlist above validates this string union.
    event: data.event as HangPowerReceipt['event'],
    observedAt: data.observedAt,
    receivedAt: data.receivedAt
  }
}
export function parseLegacyHangMarker(value: unknown): HangDetectionMarker | null {
  const data = object(value)
  if (
    !data ||
    !finite(data.detectedAt) ||
    !finite(data.parentPid) ||
    !Number.isInteger(data.parentPid) ||
    data.parentPid <= 0 ||
    !finite(data.unresponsiveMs)
  ) {
    return null
  }
  return {
    detectedAt: data.detectedAt,
    parentPid: data.parentPid,
    unresponsiveMs: data.unresponsiveMs,
    selfRecovered: data.selfRecovered === true
  }
}
function parseObservation(value: unknown): HangObservation | null {
  const data = object(value)
  if (
    !data ||
    typeof data.id !== 'string' ||
    !/^[\d:.-]{1,80}$/.test(data.id) ||
    !['heartbeat-stall', 'watchdog-gap'].includes(String(data.kind)) ||
    !finite(data.detectedAt) ||
    !finite(data.parentPid) ||
    !Number.isInteger(data.parentPid) ||
    data.parentPid <= 0 ||
    !finite(data.durationMs)
  ) {
    return null
  }
  const completedSpans: CompletedHangContext[] = []
  if (Array.isArray(data.completedSpans) && data.completedSpans.length <= 8) {
    for (const item of data.completedSpans) {
      const span = object(item)
      if (
        span &&
        typeof span.name === 'string' &&
        span.name.length <= 120 &&
        finite(span.startedAt) &&
        finite(span.completedAt) &&
        span.startedAt <= span.completedAt
      ) {
        completedSpans.push({
          name: span.name,
          startedAt: span.startedAt,
          completedAt: span.completedAt
        })
      }
    }
  }
  const gap = object(data.watchdogGap)
  return {
    id: data.id,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed observation-kind allowlist above validates this string union.
    kind: data.kind as HangObservation['kind'],
    detectedAt: data.detectedAt,
    parentPid: data.parentPid,
    durationMs: data.durationMs,
    selfRecovered: data.selfRecovered === true,
    initialSleepAssociated: data.initialSleepAssociated === true,
    snapshot: numericFields(data.snapshot, SNAPSHOT_FIELDS),
    resolution: numericFields(data.resolution, SNAPSHOT_FIELDS),
    machine: numericFields(data.machine, MACHINE_FIELDS),
    completedSpans: Array.isArray(data.completedSpans) ? completedSpans : null,
    powerEvents: Array.isArray(data.powerEvents)
      ? data.powerEvents
          .slice(-4)
          .map(parsePowerReceipt)
          .filter((v): v is HangPowerReceipt => v !== null)
      : [],
    ...(data.mainJs ? { mainJs: parseMainJsCapture(data.mainJs) } : {}),
    ...(data.native ? { native: parseNativeHangCapture(data.native) } : {}),
    ...(gap && finite(gap.observedAt) && finite(gap.durationMs)
      ? {
          watchdogGap: {
            observedAt: gap.observedAt,
            durationMs: gap.durationMs,
            snapshot: numericFields(gap.snapshot, SNAPSHOT_FIELDS)
          }
        }
      : {})
  }
}
export function emptyHangObservations(): HangObservationCollection {
  return { version: 1, observations: [], omitted: 0 }
}
export function asHangObservations(value: unknown): HangObservationCollection | null {
  const data = object(value)
  if (data?.version === 1) {
    if (!Array.isArray(data.observations) || data.observations.length > 4) {
      return null
    }
    return {
      version: 1,
      observations: data.observations
        .map(parseObservation)
        .filter((v): v is HangObservation => v !== null),
      omitted: finite(data.omitted) ? Math.min(2_147_483_647, Math.floor(data.omitted)) : 0
    }
  }
  const legacy = parseLegacyHangMarker(value)
  if (!legacy) {
    return null
  }
  return {
    version: 1,
    omitted: 0,
    observations: [
      {
        id: `${legacy.parentPid}:${legacy.detectedAt}:0`,
        kind: 'heartbeat-stall',
        detectedAt: legacy.detectedAt,
        parentPid: legacy.parentPid,
        durationMs: legacy.unresponsiveMs,
        selfRecovered: legacy.selfRecovered,
        initialSleepAssociated: false,
        snapshot: null,
        resolution: null,
        machine: null,
        completedSpans: null,
        powerEvents: []
      }
    ]
  }
}
function priority(record: HangObservation): number {
  return record.kind === 'heartbeat-stall' ? 3 : record.initialSleepAssociated ? 1 : 2
}
export function retainHangObservation(
  collection: HangObservationCollection,
  record: HangObservation
): HangObservationCollection {
  record = admitHangObservation(record)
  const existing = collection.observations.findIndex((item) => item.id === record.id)
  if (existing !== -1) {
    const old = collection.observations[existing]
    const observations = collection.observations.slice()
    const receipts = new Map(
      [...old.powerEvents, ...record.powerEvents].map(
        (item) => [`${item.event}:${item.observedAt}:${item.receivedAt}`, item] as const
      )
    )
    observations[existing] = admitHangObservation({
      ...record,
      kind: old.kind,
      id: old.id,
      detectedAt: old.detectedAt,
      parentPid: old.parentPid,
      durationMs: old.durationMs,
      initialSleepAssociated: old.initialSleepAssociated,
      snapshot: old.snapshot,
      selfRecovered: old.selfRecovered || record.selfRecovered,
      resolution: old.resolution ?? record.resolution,
      machine: old.machine ?? record.machine,
      completedSpans: old.completedSpans ?? record.completedSpans,
      mainJs: record.mainJs
        ? {
            ...record.mainJs,
            stacks: record.mainJs.stacks.length ? record.mainJs.stacks : (old.mainJs?.stacks ?? [])
          }
        : old.mainJs,
      native: record.native
        ? {
            ...record.native,
            stacks: record.native.stacks.length ? record.native.stacks : (old.native?.stacks ?? [])
          }
        : old.native,
      powerEvents: [...receipts.values()].slice(-4),
      watchdogGap:
        old.watchdogGap && old.watchdogGap.durationMs > (record.watchdogGap?.durationMs ?? -1)
          ? old.watchdogGap
          : (record.watchdogGap ?? old.watchdogGap)
    })
    return { ...collection, observations }
  }
  const candidates = [...collection.observations, record]
  const anchors = new Set(
    [
      candidates.find((item) => item.kind === 'heartbeat-stall'),
      candidates.find((item) => item.kind === 'watchdog-gap' && !item.initialSleepAssociated)
    ].filter((item): item is HangObservation => !!item)
  )
  const selected = new Set(anchors)
  const ranked = candidates
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !anchors.has(item))
    .sort((a, b) => priority(b.item) - priority(a.item) || b.index - a.index)
  for (const { item } of ranked) {
    if (selected.size < 4) {
      selected.add(item)
    }
  }
  return {
    version: 1,
    observations: candidates.filter((item) => selected.has(item)),
    omitted: Math.min(2_147_483_647, collection.omitted + candidates.length - selected.size)
  }
}
export function mergeHangObservations(
  first: HangObservationCollection,
  second: HangObservationCollection
): HangObservationCollection {
  let result = { ...first, omitted: Math.min(2_147_483_647, first.omitted + second.omitted) }
  for (const record of second.observations) {
    result = retainHangObservation(result, record)
  }
  return result
}
export function latestHangMarker(
  collection: HangObservationCollection
): HangDetectionMarker | null {
  const record = collection.observations.findLast((item) => item.kind === 'heartbeat-stall')
  return record
    ? {
        detectedAt: record.detectedAt,
        parentPid: record.parentPid,
        unresponsiveMs:
          record.durationMs +
          Math.max(0, (record.resolution?.wallMs ?? record.detectedAt) - record.detectedAt),
        selfRecovered: record.selfRecovered
      }
    : null
}
