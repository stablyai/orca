import { readCurrentProfileLifetimeParticipation } from './profile-lifetime-admission'
import { parseProfileLifetimeParticipation } from './profile-lifetime-participation'

/** Excludes the historical native lock holder only; surviving transports need separate proof. */
export function retainProfileLifetimeSuccessorAuthority(value: unknown): () => void {
  const historical = parseProfileLifetimeParticipation(value)
  const readCurrent = () => {
    const current = readCurrentProfileLifetimeParticipation()
    if (!current) {
      throw new Error('profile_lifetime_successor_participation_unavailable')
    }
    return parseProfileLifetimeParticipation(current)
  }
  const current = readCurrent()
  if (current.processIncarnation === historical.processIncarnation) {
    throw new Error('profile_lifetime_successor_same_process')
  }
  if (
    current.physicalRoot !== historical.physicalRoot ||
    JSON.stringify(current.root) !== JSON.stringify(historical.root) ||
    JSON.stringify(current.lock) !== JSON.stringify(historical.lock)
  ) {
    throw new Error('profile_lifetime_successor_identity_changed')
  }
  const expected = JSON.stringify(current)
  const assertCurrent = () => {
    if (JSON.stringify(readCurrent()) !== expected) {
      throw new Error('profile_lifetime_successor_authority_changed')
    }
  }
  assertCurrent()
  return assertCurrent
}
