/** Pure edits of the per-profile enabled sets kept in browser-session-meta.json. */
export type EnabledExtensionIdsByProfileId = Record<string, string[]>

export function withExtensionEnabled(
  byProfile: EnabledExtensionIdsByProfileId,
  profileId: string,
  extensionId: string,
  enabled: boolean
): EnabledExtensionIdsByProfileId {
  const ids = new Set(byProfile[profileId] ?? [])
  if (enabled) {
    ids.add(extensionId)
  } else {
    ids.delete(extensionId)
  }
  return { ...byProfile, [profileId]: [...ids] }
}

export function withoutExtension(
  byProfile: EnabledExtensionIdsByProfileId,
  extensionId: string
): EnabledExtensionIdsByProfileId {
  return Object.fromEntries(
    Object.entries(byProfile).map(([profileId, ids]) => [
      profileId,
      ids.filter((id) => id !== extensionId)
    ])
  )
}
