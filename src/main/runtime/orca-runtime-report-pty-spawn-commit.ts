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
