import type { WebSocket } from 'ws'

export type BunServerWebSocket = {
  data: unknown
  readonly readyState: number
  getBufferedAmount(): number
  send(data: string | ArrayBuffer | ArrayBufferView): number
  close(code?: number, reason?: string): void
  terminate(): void
  ping(data?: string | ArrayBuffer | ArrayBufferView): void
}

export type BunSocketAdapter = WebSocket & {
  readonly raw: BunServerWebSocket
  readonly notify: (event: string, ...args: unknown[]) => void
}

export function adaptBunSocket(socket: BunServerWebSocket): BunSocketAdapter {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const adapted = {
    raw: socket,
    OPEN: 1,
    get readyState(): number {
      return socket.readyState
    },
    get bufferedAmount(): number {
      return socket.getBufferedAmount()
    },
    send(data: string | ArrayBuffer | ArrayBufferView): void {
      socket.send(data)
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason)
    },
    terminate(): void {
      socket.terminate()
    },
    ping(data?: string | ArrayBuffer | ArrayBufferView): void {
      socket.ping(data)
    },
    on(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return adapted as BunSocketAdapter
    },
    off(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      listeners.get(event)?.delete(listener)
      return adapted as BunSocketAdapter
    },
    once(event: string, listener: (...args: unknown[]) => void): BunSocketAdapter {
      const onceListener = (...args: unknown[]) => {
        listeners.get(event)?.delete(onceListener)
        listener(...args)
      }
      return adapted.on(event, onceListener)
    },
    notify(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args)
      }
    }
  } as unknown as BunSocketAdapter
  return adapted
}
