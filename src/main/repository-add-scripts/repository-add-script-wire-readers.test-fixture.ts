export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `result` of an ok RPC response; anything else is a failed expectation. */
export function okResultOf(response: unknown): Record<string, unknown> {
  if (isRecord(response) && response.ok === true && isRecord(response.result)) {
    return response.result
  }
  throw new Error('Expected an ok response with an object result.')
}

export function offerIdentityIn(result: Record<string, unknown>): {
  token: string
  hostId: string
  repoId: string
} {
  const offer = result.repositoryAddScriptPreview
  if (
    isRecord(offer) &&
    typeof offer.token === 'string' &&
    typeof offer.hostId === 'string' &&
    typeof offer.repoId === 'string'
  ) {
    return { token: offer.token, hostId: offer.hostId, repoId: offer.repoId }
  }
  throw new Error('Expected the result to carry an offer.')
}

export function offeredRepoIdsIn(result: Record<string, unknown>): string[] {
  const offers = result.repositoryAddScriptPreviews
  if (!Array.isArray(offers)) {
    throw new Error('Expected the result to carry offers.')
  }
  return offers.map((offer) => {
    if (isRecord(offer) && typeof offer.repoId === 'string') {
      return offer.repoId
    }
    throw new Error('Expected every offer to name a repo.')
  })
}
