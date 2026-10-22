/** An idempotent callback: the spawn-commit report and the stable-pane claim release run once. */
export function createIdempotentCallback(callback?: () => void): () => void {
  let reported = false
  return () => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
}
