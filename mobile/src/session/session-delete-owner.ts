import { useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'

/** The checkout host this session entry first proved, and whether a later read named another. */
export type SessionOwnerProof = {
  key: string
  owner: ExecutionHostId | null
  conflict: boolean
}

// A bare-id refresh can name a same-id checkout on another host once the first is gone; that is not
// the checkout this entry opened, so the entry keeps its first owner and stops offering Delete.
export function nextSessionOwnerProof(
  proof: SessionOwnerProof | null,
  key: string,
  observed: ExecutionHostId | null
): SessionOwnerProof {
  if (!proof || proof.key !== key) {
    return { key, owner: observed, conflict: false }
  }
  if (observed === null || observed === proof.owner || proof.conflict) {
    return proof
  }
  return proof.owner === null ? { ...proof, owner: observed } : { ...proof, conflict: true }
}

/** The proven owner for Delete, or null while unproven or once the entry saw two. */
export function useProvenSessionOwner(
  key: string,
  observed: ExecutionHostId | null
): ExecutionHostId | null {
  const [proof, setProof] = useState<SessionOwnerProof | null>(null)
  const next = nextSessionOwnerProof(proof, key, observed)
  if (next !== proof) {
    setProof(next)
  }
  return next.conflict ? null : next.owner
}
