export type MirroredWriteSource = 'persisted' | 'page'
type MirroredKeyListener = (value: string | null, source: MirroredWriteSource) => void
const keyListeners = new Map<string, Set<MirroredKeyListener>>()

export function subscribeMirroredKey(key: string, listener: MirroredKeyListener): () => void {
  const forKey = keyListeners.get(key) ?? new Set<MirroredKeyListener>()
  keyListeners.set(key, forKey)
  forKey.add(listener)
  return () => {
    forKey.delete(listener)
  }
}

export function notifyMirroredKey(
  key: string,
  value: string | null,
  source: MirroredWriteSource
): void {
  for (const listener of keyListeners.get(key) ?? []) {
    listener(value, source)
  }
}
