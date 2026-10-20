/** A user's rename, from the first source that has one. Live OSC titles are not manual. */
export function resolveManualTerminalTitle(
  ...sources: ({ customTitle?: string | null } | null | undefined)[]
): string | null {
  for (const source of sources) {
    const title = source?.customTitle?.trim()
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
