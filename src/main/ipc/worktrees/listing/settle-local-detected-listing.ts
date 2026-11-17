/**
 * A local listing must not hold renderer hydration hostage: one registered repo whose listing
 * never settles keeps "Finding workspaces…" up forever, because only the direct-SSH branch of
 * the listDetected handler raced a deadline (#43572). Resolve to null — the handler's existing
 * normalization turns that into the metadata-fallback result — and say why, so a stuck repo is
 * diagnosable instead of silent.
 */
export function settleLocalDetectedListingWithin<T>(
  listing: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      onTimeout()
      resolve(null)
    }, timeoutMs)
  })
  // Promise.race keeps handlers on the listing, so a late rejection after the deadline is not unhandled.
  return Promise.race([listing, deadline]).finally(() => clearTimeout(timer))
}
