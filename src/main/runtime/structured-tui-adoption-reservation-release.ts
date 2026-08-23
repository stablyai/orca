const RELEASE_ATTEMPTS = 3
const BACKGROUND_RETRY_MS = 1_000

function retryInBackground(release: () => Promise<void>, onReleased: () => void): void {
  const timer = setTimeout(() => {
    void release().then(onReleased, () => retryInBackground(release, onReleased))
  }, BACKGROUND_RETRY_MS)
  timer.unref?.()
}

export async function releaseStructuredTuiAdoptionReservation(
  release: () => Promise<void>,
  onReleased: () => void
): Promise<unknown | null> {
  let failure: unknown = null
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await release()
      onReleased()
      return null
    } catch (error) {
      failure = error
    }
  }
  retryInBackground(release, onReleased)
  return failure
}
