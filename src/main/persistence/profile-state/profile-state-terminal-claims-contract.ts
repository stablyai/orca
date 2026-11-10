export type ProfileTerminalClaimsRequest = { userDataPath: string; profileId: string }
export type ProfileTerminalClaims =
  | { kind: 'unknown' }
  | { kind: 'known'; location: string; numericIds: string[]; revision?: number }

export function isProfileTerminalClaimsRequest(value: {
  userDataPath?: unknown
  profileId?: unknown
}): value is ProfileTerminalClaimsRequest {
  return (
    typeof value.userDataPath === 'string' &&
    value.userDataPath.length > 0 &&
    typeof value.profileId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.profileId)
  )
}

export function isProfileTerminalClaims(value: unknown): value is ProfileTerminalClaims {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  if (value.kind === 'unknown') {
    return true
  }
  return (
    value.kind === 'known' &&
    'location' in value &&
    typeof value.location === 'string' &&
    'numericIds' in value &&
    Array.isArray(value.numericIds) &&
    value.numericIds.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id)) &&
    (!('revision' in value) ||
      (typeof value.revision === 'number' &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0))
  )
}
