import type { SessionSearchInventoryMember } from './session-search-inventory-relation'

export type SessionSearchEpochIdentity =
  | { kind: 'observation-epochs'; key: number }
  | { kind: 'epochs' | 'removal-epochs'; key: string }
export type SessionSearchInventoryFloor = { cutoff: number; epoch?: SessionSearchEpochIdentity }

export function sessionSearchEpochIdentity(
  kind: SessionSearchInventoryMember,
  key: string
): SessionSearchEpochIdentity | undefined {
  return kind === 'observation-epochs'
    ? { kind, key: Number(key) }
    : kind === 'epochs' || kind === 'removal-epochs'
      ? { kind, key }
      : undefined
}

export function changeSessionSearchInventoryFloor(
  floor: SessionSearchInventoryFloor,
  epoch?: SessionSearchEpochIdentity,
  cutoff?: number
): SessionSearchInventoryFloor | undefined {
  if (!epoch) {
    return undefined
  }
  const selected = floor.epoch?.kind === epoch.kind && floor.epoch.key === epoch.key
  if (cutoff === undefined) {
    return selected ? undefined : floor
  }
  if (selected && cutoff > floor.cutoff) {
    return undefined
  }
  return selected || cutoff < floor.cutoff ? { cutoff, epoch } : floor
}
