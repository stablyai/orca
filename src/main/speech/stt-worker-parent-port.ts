import type { MessagePortMain } from 'electron'

type UtilityParentPort = {
  on(
    event: 'message',
    listener: (event: { data: unknown; ports: MessagePortMain[] }) => void
  ): unknown
  postMessage(message: unknown): void
}

export type SttWorkerParentPort = {
  post(message: unknown): void
  onMessage(listener: (message: unknown, ports: readonly MessagePortMain[]) => void): void
}

/** Electron's utility process (desktop) or a forked child (orcad). */
export function connectSttWorkerParentPort(): SttWorkerParentPort {
  // Electron types it as always set, but only a utility process has one.
  const utilityPort: UtilityParentPort | undefined = process.parentPort
  if (utilityPort) {
    return {
      post: (message) => utilityPort.postMessage(message),
      onMessage: (listener) =>
        utilityPort.on('message', (event) => listener(event.data, event.ports))
    }
  }
  if (!process.send) {
    throw new Error('The speech worker must run as a child process')
  }
  // The host died without killing us; don't keep a recognizer loaded for nobody.
  process.on('disconnect', () => process.exit(0))
  return {
    post: (message) => process.send?.(message),
    onMessage: (listener) => process.on('message', (message) => listener(message, []))
  }
}
