import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { SshPtyLeaseOperations } from './ssh-pty-lease-operations'
import { normalizeSshRemotePtyLease } from './ssh-normalization'

/** Caller must retain the exact selection and retirement timestamp before starting cleanup. */
export async function retireSshRemotePtyLeaseSelection(
  operations: SshPtyLeaseOperations,
  targetId: string,
  expected: readonly SshRemotePtyLease[],
  retiredAt: number
): Promise<{ assertRetired: () => void }> {
  if (!Number.isSafeInteger(retiredAt) || retiredAt < 0 || expected.length > 10_000) {
    throw new Error('ssh_reset_lease_selection_invalid')
  }
  const seen = new Set<string>()
  const entries = expected.map((value) => {
    const lease = normalizeSshRemotePtyLease(value)
    if (
      !lease ||
      lease.targetId !== targetId ||
      !Number.isFinite(lease.createdAt) ||
      !Number.isFinite(lease.updatedAt) ||
      seen.has(lease.ptyId) ||
      serializeOrcadMigrationValue(lease) !== serializeOrcadMigrationValue(value)
    ) {
      throw new Error('ssh_reset_lease_selection_invalid')
    }
    seen.add(lease.ptyId)
    const before = serializeOrcadMigrationValue(lease)
    const after: SshRemotePtyLease =
      lease.state === 'terminated' || lease.state === 'expired'
        ? lease
        : { ...lease, state: 'expired', updatedAt: retiredAt }
    return {
      ptyId: lease.ptyId,
      before,
      serializedAfter: serializeOrcadMigrationValue(after)
    }
  })
  const selectCurrent = () => {
    const byId = new Map<string, SshRemotePtyLease[]>()
    for (const lease of operations.state.sshRemotePtyLeases ?? []) {
      if (lease.targetId === targetId && seen.has(lease.ptyId)) {
        const matches = byId.get(lease.ptyId) ?? []
        matches.push(lease)
        byId.set(lease.ptyId, matches)
      }
    }
    return entries.map((entry) => {
      const matches = byId.get(entry.ptyId) ?? []
      const current = matches[0]
      const canonical = current && serializeOrcadMigrationValue(current)
      if (
        matches.length !== 1 ||
        (canonical !== entry.before && canonical !== entry.serializedAfter)
      ) {
        throw new Error('ssh_reset_lease_selection_changed')
      }
      return { entry, current }
    })
  }
  const selected = selectCurrent()
  // Whole selection preflight and in-memory retirement have no asynchronous gap.
  for (const { entry, current } of selected) {
    if (entry.before !== entry.serializedAfter) {
      current.state = 'expired'
      current.updatedAt = retiredAt
    }
  }
  // Reflush exact retries after an earlier uncertain durability result.
  await operations.flushDurableStateOrThrowAsync()
  const assertRetired = () => {
    for (const { entry, current } of selectCurrent()) {
      if (serializeOrcadMigrationValue(current) !== entry.serializedAfter) {
        throw new Error('ssh_reset_lease_retirement_unconfirmed')
      }
    }
  }
  assertRetired()
  return { assertRetired }
}
