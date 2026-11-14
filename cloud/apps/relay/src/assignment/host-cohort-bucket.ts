import { createHash } from 'node:crypto'

// A host's stable 0-99 bucket: a cohort of N percent is the hosts below N.
export function hostCohortBucket(identity: { userId: string; relayHostId: string }): number {
  return (
    createHash('sha256')
      .update(JSON.stringify([identity.userId, identity.relayHostId]))
      .digest()
      .readUInt32BE(0) % 100
  )
}
