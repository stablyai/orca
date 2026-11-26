import { createComposerUsageChoiceStore } from '../composer-usage/composer-usage-choice-store'

export const TABLET_USAGE_RAIL_KEY = 'orca:tabletUsageRail'

const store = createComposerUsageChoiceStore<'expanded' | 'collapsed'>(
  TABLET_USAGE_RAIL_KEY,
  (raw: string | null | undefined) => (raw === 'collapsed' ? 'collapsed' : 'expanded'),
  'Tablet usage rail'
)

export function setTabletUsageRailExpanded(expanded: boolean): void {
  store.set(expanded ? 'expanded' : 'collapsed')
}

/** Whether the tablet's right-hand usage rail shows its rings or only its toggle. */
export function useTabletUsageRailExpanded(): boolean {
  return store.use() === 'expanded'
}
