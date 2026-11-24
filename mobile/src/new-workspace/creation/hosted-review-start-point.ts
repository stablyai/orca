export type HostedReviewStartPointType = 'issue' | 'pr' | 'mr'

export function shouldResolveHostedReviewStartPoint(args: {
  type: HostedReviewStartPointType
  baseBranchOverride?: string | null
}): boolean {
  if (args.type !== 'pr' && args.type !== 'mr') {
    return false
  }
  return !args.baseBranchOverride?.trim()
}
