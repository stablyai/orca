export function createStablePaneCreateRelease(release?: () => void): () => void {
  let current = release
  return () => {
    current?.()
    current = undefined
  }
}
