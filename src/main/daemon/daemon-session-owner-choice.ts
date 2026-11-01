import type { PtyProcessInfo } from '../providers/pty-provider-contract'

export type OwnerCandidate<T> = { provider: T; process: PtyProcessInfo }

export function chooseSessionOwner<T>(args: {
  candidates: readonly OwnerCandidate<T>[]
  inventoryComplete: boolean
  expectedIncarnationId?: string
  expectedIncarnationIsAuthoritative: boolean
}): OwnerCandidate<T> | undefined {
  const { candidates, expectedIncarnationId } = args
  const exact = expectedIncarnationId
    ? candidates.filter(({ process }) => process.incarnationId === expectedIncarnationId)
    : []
  // Unique spawn incarnations prove an exact owner even when unrelated inventories fail (#30486).
  if (new Set(exact.map(({ provider }) => provider)).size === 1) {
    return exact[0]
  }
  const providers = new Set(candidates.map(({ provider }) => provider))
  return !args.expectedIncarnationIsAuthoritative && args.inventoryComplete && providers.size === 1
    ? candidates[0]
    : undefined
}
