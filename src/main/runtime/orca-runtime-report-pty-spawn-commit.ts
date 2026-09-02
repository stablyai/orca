/** Create an idempotent callback for the provider's spawn-commit boundary. */
export function createPtySpawnCommitReporter(callback?: () => void): () => void {
  let reported = false
  return () => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
}
