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
