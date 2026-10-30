import {
  readPushNotificationsPreference,
  type PushNotificationsPreference
} from '../storage/preferences'

type ConsentResult =
  | { status: 'observed'; preference: PushNotificationsPreference }
  | { status: 'retired' }
export type ConsentPreparation = { readonly result: Promise<ConsentResult>; release(): void }
type Cell = { current?: () => boolean; deliver?: (result: ConsentResult) => void }
class ConsentSlot {}
type ConsentPhase = { slot: ConsentSlot; selected?: Cell }
const rootSlot = new ConsentSlot()
const waiting = new Map<ConsentSlot, Cell>()
let physical: ConsentPhase | undefined

function clear(cell: Cell): void {
  cell.current = undefined
  cell.deliver = undefined
}
function retire(slot: ConsentSlot, cell: Cell): void {
  if (waiting.get(slot) === cell) {
    waiting.delete(slot)
  }
  if (physical?.selected === cell) {
    physical.selected = undefined
  }
  const deliver = cell.deliver
  clear(cell)
  deliver?.({ status: 'retired' })
}
function finish(phase: ConsentPhase, preference: PushNotificationsPreference): void {
  if (physical !== phase) {
    return
  }
  physical = undefined
  const cell = phase.selected
  phase.selected = undefined
  if (cell) {
    const current = cell.current?.() === true
    const deliver = cell.deliver
    clear(cell)
    deliver?.(current ? { status: 'observed', preference } : { status: 'retired' })
  }
  pump()
}
function pump(): void {
  if (physical) {
    return
  }
  for (const [slot, cell] of waiting) {
    if (!cell.current?.()) {
      retire(slot, cell)
      continue
    }
    waiting.delete(slot)
    const phase: ConsentPhase = { slot, selected: cell }
    physical = phase
    void readPushNotificationsPreference().then(
      (preference) => finish(phase, preference),
      () => finish(phase, { value: null, loaded: false })
    )
    return
  }
}
export function preparePushConsent(isCurrent: () => boolean): ConsentPreparation {
  const own = Promise.withResolvers<ConsentResult>()
  const slot = new ConsentSlot()
  const cell: Cell = { current: isCurrent, deliver: own.resolve }
  waiting.set(slot, cell)
  pump()
  return { result: own.promise, release: () => retire(slot, cell) }
}
export function refreshPushConsent(
  isCurrent: () => boolean,
  observed: (preference: PushNotificationsPreference) => void
): () => void {
  if (physical?.slot === rootSlot && physical.selected) {
    retire(rootSlot, physical.selected)
  }
  const old = waiting.get(rootSlot)
  if (old) {
    clear(old)
  }
  const cell: Cell = {
    current: isCurrent,
    deliver: (result) => {
      if (result.status === 'observed') {
        observed(result.preference)
      }
    }
  }
  waiting.set(rootSlot, cell)
  pump()
  return () => retire(rootSlot, cell)
}
export function pushConsentSnapshotForTests() {
  const selected = physical?.selected
  return {
    physical: Number(physical !== undefined),
    selected: Number(selected !== undefined),
    queued: waiting.size,
    root: Number(waiting.has(rootSlot)) + Number(physical?.slot === rootSlot && !!selected),
    hosts:
      [...waiting.keys()].filter((slot) => slot !== rootSlot).length +
      Number(physical?.slot !== rootSlot && !!selected),
    callables: [...waiting.values(), ...(selected ? [selected] : [])].reduce(
      (n, cell) => n + Number(!!cell.current) + Number(!!cell.deliver),
      0
    )
  }
}
