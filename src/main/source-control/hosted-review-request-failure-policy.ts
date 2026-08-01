export type HostedReviewRequestFailurePolicy = 'return-null' | 'throw-transient' | 'throw-all'

export function shouldThrowHostedReviewHttpStatus(
  policy: HostedReviewRequestFailurePolicy | undefined,
  status: number
): boolean {
  return policy === 'throw-all' || (policy === 'throw-transient' && status !== 404)
}

export function resolveHostedReviewRequestFailure(
  policy: HostedReviewRequestFailurePolicy | undefined,
  error: unknown
): null {
  if (policy && policy !== 'return-null') {
    throw error
  }
  return null
}
