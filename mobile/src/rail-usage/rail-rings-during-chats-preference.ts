import { createComposerUsageChoiceStore } from '../composer-usage/composer-usage-choice-store'

export const RAIL_RINGS_DURING_CHATS_KEY = 'orca:railUsageRingsDuringChats'

const store = createComposerUsageChoiceStore<'on' | 'off'>(
  RAIL_RINGS_DURING_CHATS_KEY,
  (raw: string | null | undefined) => (raw === 'off' ? 'off' : 'on'),
  'Rail usage rings during chats'
)

export function setRailRingsDuringChats(shown: boolean): void {
  store.set(shown ? 'on' : 'off')
}

/** Whether the Duo side rail keeps its usage rings in a chat that leaves the column free. */
export function useRailRingsDuringChats(): boolean {
  return store.use() === 'on'
}
