import type { EventProps } from '../../shared/telemetry/telemetry-event-classification'
import { nativeChatPickerItemAcceptedSchema } from '../../shared/telemetry/schemas/telemetry-native-feature-event-schemas'
import type { Store } from '../persistence/loading-store/store'

type DailyRow = EventProps<'native_chat_picker_accepts_daily'>
type SettingsStore = Pick<Store, 'getSettings' | 'updateSettings'>
type Telemetry = NonNullable<ReturnType<Store['getSettings']>['telemetry']>
type Counts = NonNullable<Telemetry['pickerAccepts']>['counts']

const utcDay = (now: number): number => Math.floor(now / 86_400_000)

function save(store: SettingsStore, telemetry: Telemetry, day: number, counts: Counts): boolean {
  try {
    store.updateSettings({ telemetry: { ...telemetry, pickerAccepts: { day, counts } } })
    return true
  } catch (err) {
    console.warn('[telemetry] failed to save picker counts', err)
    return false
  }
}

/** Sends each finished day's counts once; cleared before sending, so a crash can drop a day but never repeat it. */
export function flushPickerAccepts(
  now: number,
  store: SettingsStore | null,
  emit: (name: 'native_chat_picker_accepts_daily', row: DailyRow) => boolean
): void {
  const telemetry = store?.getSettings().telemetry
  const saved = telemetry?.pickerAccepts
  if (!store || !telemetry || !saved || saved.day >= utcDay(now) || saved.counts.length === 0) {
    return
  }
  if (!save(store, telemetry, utcDay(now), [])) {
    return
  }
  const usageDay = new Date(saved.day * 86_400_000).toISOString().slice(0, 10)
  for (const [agentKind, itemKind, count] of saved.counts) {
    emit('native_chat_picker_accepts_daily', {
      agent_kind: agentKind,
      item_kind: itemKind,
      accept_count: count,
      usage_day: usageDay
    })
  }
}

/** Counts one validated accept toward today's row instead of sending it. */
export function rollUpPickerAccept(
  props: unknown,
  now: number,
  store: SettingsStore,
  emit: (name: 'native_chat_picker_accepts_daily', row: DailyRow) => boolean
): boolean {
  flushPickerAccepts(now, store, emit)
  const parsed = nativeChatPickerItemAcceptedSchema.safeParse(props)
  const telemetry = store.getSettings().telemetry
  if (!parsed.success || !telemetry) {
    return false
  }
  const accept = parsed.data
  const saved = telemetry.pickerAccepts
  const today = saved?.day === utcDay(now) ? saved.counts : []
  let counted = false
  const counts: Counts = today.map(([agentKind, itemKind, count]) => {
    const match = agentKind === accept.agent_kind && itemKind === accept.item_kind
    counted ||= match
    return [agentKind, itemKind, match ? count + 1 : count]
  })
  if (!counted) {
    counts.push([accept.agent_kind, accept.item_kind, 1])
  }
  return save(store, telemetry, utcDay(now), counts)
}
