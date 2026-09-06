export const CONTROL_GENERATION_STATE = {
  ACTIVE: 'active',
  ORPHANED: 'orphaned',
  DRAIN_ONLY: 'drain-only',
  FENCED: 'fenced',
  CLOSED: 'closed'
} as const

export const CONTROL_CONTINUITY_LIMITS = {
  orphanGraceMs: 30 * 1000,
  authRefreshMinBeforeExpiryMs: 60 * 1000,
  authRefreshMaxBeforeExpiryMs: 120 * 1000,
  expiredAuthExistingSpliceGraceMs: 60 * 1000
} as const

export function controlLossDisposition(input: {
  matchingResumeSecret: boolean
  competingGeneration: boolean
}): 'rebind' | 'fence-old' | 'orphan-grace' {
  if (input.matchingResumeSecret) return 'rebind'
  if (input.competingGeneration) return 'fence-old'
  return 'orphan-grace'
}

export function mayStartNewRelayWork(state: string, authExpired: boolean): boolean {
  return state === CONTROL_GENERATION_STATE.ACTIVE && !authExpired
}

export interface RelayAuthIdentity {
  sub: string
  prof: string
  org?: string
  relayHostId: string
}

export function preservesRelayAuthIdentity(previous: RelayAuthIdentity, refreshed: RelayAuthIdentity): boolean {
  return (
    previous.sub === refreshed.sub &&
    previous.prof === refreshed.prof &&
    previous.org === refreshed.org &&
    previous.relayHostId === refreshed.relayHostId
  )
}
