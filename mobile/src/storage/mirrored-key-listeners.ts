type MirroredKeyListener = (value: string | null) => void
const keyListeners = new Map<string, Set<MirroredKeyListener>>()

export function subscribeMirroredKey(key: string, listener: MirroredKeyListener): () => void {
  const forKey = keyListeners.get(key) ?? new Set<MirroredKeyListener>()
  keyListeners.set(key, forKey)
  forKey.add(listener)
  return () => {
    forKey.delete(listener)
  }
}

export function notifyMirroredKey(key: string, value: string | null): void {
  for (const listener of keyListeners.get(key) ?? []) {
    listener(value)
  }
}
