import { getOptionalNullableNumberFlag, getOptionalNumberFlag } from '../flags'

type ReviewTargetLinks = {
  linkedIssue: number | null | undefined
  linkedPR: number | null | undefined
}

// Why: only `set` may clear a link, so `create` parses the same flags non-nullable.
export function getReviewTargetLinkFlags(
  flags: Map<string, string | boolean>,
  options: { nullable?: boolean } = {}
): ReviewTargetLinks {
  const getFlag = options.nullable ? getOptionalNullableNumberFlag : getOptionalNumberFlag
  return {
    linkedIssue: getFlag(flags, 'issue'),
    linkedPR: getFlag(flags, 'pr')
  }
}
