import type { MobileSessionTab } from '../../mobile-session-route-types'

export type DraftTabOwnership = { scope: string; hostListed: Set<string>; phoneOwned: Set<string> }

// Why: created/optimistic tabs precede their host listing; only a host-listed tab's absence proves retirement.
export function trackPhoneOwnedDraftTabs(
  ref: { current: DraftTabOwnership | null },
  scope: string,
  listedTabs: readonly MobileSessionTab[],
  phoneTabs: readonly MobileSessionTab[]
): ReadonlySet<string> {
  let ownership = ref.current
  if (ownership?.scope !== scope) {
    // Tabs restored before any host listing are unproven, so they are not claimed as phone-owned.
    ownership = { scope, hostListed: new Set(), phoneOwned: new Set() }
    ref.current = ownership
  } else {
    for (const tab of phoneTabs) {
      if (!ownership.hostListed.has(tab.id)) {
        ownership.phoneOwned.add(tab.id)
      }
    }
  }
  for (const tab of listedTabs) {
    ownership.hostListed.add(tab.id)
    ownership.phoneOwned.delete(tab.id)
  }
  return ownership.phoneOwned
}
