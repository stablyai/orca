import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const SOCKET_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
}

export type EdgeSpeechHandlers = {
  open: () => void
  error: () => void
  close: () => void
  unexpectedResponse: (
    request: { destroy: () => void },
    response: { resume: () => void; statusCode?: number }
  ) => void
  message: (data: unknown, isBinary: boolean) => void
}

/** The socket the synthesizer drives. Production opens Microsoft; tests pass a local double. */
export type EdgeSpeechSocket = {
  send: (data: string) => void
  close: () => void
  subscribe: (handlers: EdgeSpeechHandlers) => void
}

/** Wraps the Microsoft socket so the synthesizer never depends on the ws client type. */
export function openEdgeSpeechSocket(url: string): EdgeSpeechSocket {
  const socket = new WebSocket(url, {
    headers: {
      ...SOCKET_HEADERS,
      Cookie: `muid=${randomUUID().replaceAll('-', '').toUpperCase()};`
    },
    handshakeTimeout: 10_000
  })
  return {
    send: (data) => {
      socket.send(data)
    },
    close: () => {
      socket.close()
    },
    subscribe: (handlers) => {
      socket.on('open', () => {
        handlers.open()
      })
      socket.on('error', () => {
        handlers.error()
      })
      socket.on('close', () => {
        handlers.close()
      })
      socket.on('unexpected-response', (request, response) => {
        handlers.unexpectedResponse(request, response)
      })
      socket.on('message', (data, isBinary) => {
        handlers.message(data, isBinary)
      })
    }
  }
}
