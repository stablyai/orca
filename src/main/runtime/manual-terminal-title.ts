import { normalizeCompatibleAgentTitleForOwner } from '../../shared/agent-title-owner'
import { resolveTerminalTabTitle } from '../../shared/tab-title-resolution'

/** Rank a user's rename ahead of the live title agents keep repainting. */
export function resolveProjectedMobileTerminalTitle<T extends { title?: string | null }>(
  sources: Parameters<typeof resolveManualTerminalTitle>,
  liveTitle: string | null | undefined,
  tab: T,
  ownerAgent: Parameters<typeof normalizeCompatibleAgentTitleForOwner>[1],
  ownerOptions: Parameters<typeof normalizeCompatibleAgentTitleForOwner>[2]
): { manualTitle: string | null; normalizedLiveTitle: string; title: string } {
  const manualTitle = resolveManualTerminalTitle(...sources)
  const normalizedLiveTitle = normalizeCompatibleAgentTitleForOwner(
    liveTitle ?? '',
    ownerAgent,
    ownerOptions
  )
  // Desktop ranking beats a fresher main title; windows emit generated names only while shown.
  const title =
    manualTitle ??
    resolveTerminalTabTitle({ ...tab, title: normalizedLiveTitle }, true, normalizedLiveTitle)
  return { manualTitle, normalizedLiveTitle, title }
}

/** A user's rename, from the first source that has one. Live OSC titles are not manual. */
export function resolveManualTerminalTitle(
  ...sources: ({ customTitle?: string | null; manualTitle?: string | null } | null | undefined)[]
): string | null {
  for (const source of sources) {
    const title = source?.customTitle?.trim() || source?.manualTitle?.trim()
    if (title) {
      return title
    }
  }
  return null
}

/** Keep an explicit null from the snapshot so a client can tell "cleared" from "unknown". */
export function publishedCustomTitle(
  manualTitle: string | null,
  tabCustomTitle: string | null | undefined
): { customTitle?: string | null } {
  if (manualTitle) {
    return { customTitle: manualTitle }
  }
  return tabCustomTitle !== undefined ? { customTitle: tabCustomTitle } : {}
}

export function resolveSessionBackedManualTerminalTitle(args: {
  manualTitle: string | null
  tabCustomTitle: string | null | undefined
  syncedTabCustomTitle: string | null | undefined
  providerSessionIds: readonly (string | null | undefined)[]
  getSessionCustomTitle?: (sessionId: string) => string | null
}): string | null {
  if (
    args.manualTitle !== null ||
    args.tabCustomTitle === null ||
    args.syncedTabCustomTitle === null ||
    !args.getSessionCustomTitle
  ) {
    return args.manualTitle
  }
  for (const sessionId of args.providerSessionIds) {
    const title = sessionId ? args.getSessionCustomTitle(sessionId)?.trim() : null
    if (title) {
      return title
    }
  }
  return null
}
