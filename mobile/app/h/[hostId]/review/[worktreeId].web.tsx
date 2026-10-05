import { MobileDiffReviewRouteScreen } from '../../../../src/session/MobileDiffReviewRouteScreen'

/**
 * Web sibling for diff review.
 *
 * The shell renders this page for this route, so there is no shell to mount here and no flag to
 * read. The screen reads its own params, so this file is the whole of the difference: its native
 * sibling reaches OrcaMobileWebShellView, whose module throws at import in a browser.
 */
export default function MobileDiffReviewScreen() {
  return <MobileDiffReviewRouteScreen />
}
