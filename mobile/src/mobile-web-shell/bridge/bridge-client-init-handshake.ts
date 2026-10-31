import { BRIDGE_PROTOCOL_VERSION, type BridgeClientMessage } from './bridge-envelope'
import { NEGOTIATED_PAGE_STORAGE_KEYS } from '../page-storage-keys'

export const BRIDGE_READY_RETRY_MIN_MS = 50
export const BRIDGE_READY_RETRY_MAX_MS = 2000

export type BridgeInitHandshake = {
  start: () => void
  stop: () => void
  restart: () => void
}

// Ask ready on backoff because the page may load/reload after a previous init was sent; the shell needs no delivery history to repair it.
export function createBridgeInitHandshake(ask: () => void): BridgeInitHandshake {
  let timer: ReturnType<typeof setTimeout> | null = null
  let delayMs = BRIDGE_READY_RETRY_MIN_MS

  function start(): void {
    ask()
    timer = setTimeout(() => {
      delayMs = Math.min(delayMs * 2, BRIDGE_READY_RETRY_MAX_MS)
      start()
    }, delayMs)
  }

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    start,
    stop,
    restart: (): void => {
      stop()
      delayMs = BRIDGE_READY_RETRY_MIN_MS
      start()
    }
  }
}

export function createPageReadyFrame(): Extract<BridgeClientMessage, { type: 'ready' }> {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: 'ready',
    storageKeys: [...NEGOTIATED_PAGE_STORAGE_KEYS]
  }
}
