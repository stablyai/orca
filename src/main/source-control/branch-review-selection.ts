// Reviews one head-scoped request asks for. A head rarely has more; when it does, see below.
export const BRANCH_REVIEW_PAGE_SIZE = 10

/**
 * The review for one head, from reviews filtered to exactly that head and newest first: the open
 * one if any (a head has at most one open review per base), else the most recent (#28324: a newer
 * closed review must not hide the open one).
 */
export function pickReviewForHead<T>(
  reviews: readonly T[],
  isOpen: (review: T) => boolean
): T | undefined {
  return reviews.find(isOpen) ?? reviews[0]
}

/** `pickReviewForHead` over a provider list that returns one page at a time. */
export async function selectReviewForHead<T>(
  fetchReviews: (states: 'all' | 'open') => Promise<readonly T[]>,
  isOpen: (review: T) => boolean
): Promise<T | undefined> {
  const recent = await fetchReviews('all')
  if (recent.length < BRANCH_REVIEW_PAGE_SIZE || recent.some(isOpen)) {
    return pickReviewForHead(recent, isOpen)
  }
  // Why: a full page of closed reviews can hide an older open one; ask only then, so ordinary
  // heads stay at one request.
  return (await fetchReviews('open')).find(isOpen) ?? recent[0]
}
