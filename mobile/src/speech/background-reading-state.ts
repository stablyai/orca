// Why: free of React Native and storage imports because the transport reads it to keep the host
// link foreground while the background reader runs (`host-logical-client.ts`).
let active = false
const listeners = new Set<() => void>()

export function backgroundReadingActive(): boolean {
  return active
}

export function subscribeBackgroundReading(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setBackgroundReadingActive(next: boolean): void {
  if (active === next) {
    return
  }
  active = next
  for (const listener of listeners) {
    listener()
  }
}
