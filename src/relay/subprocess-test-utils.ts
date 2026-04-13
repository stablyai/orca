import { spawn, type ChildProcess } from 'child_process'
import {
  RELAY_SENTINEL,
  FrameDecoder,
  encodeJsonRpcFrame,
  parseJsonRpcMessage,
  MessageType,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification
} from './protocol'

export type RelayProcess = {
  proc: ChildProcess
  responses: (JsonRpcResponse | JsonRpcNotification)[]
  sentinelReceived: Promise<void>
  send: (method: string, params?: Record<string, unknown>) => number
  sendNotification: (method: string, params?: Record<string, unknown>) => void
  waitForResponse: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>
  waitForNotification: (method: string, timeoutMs?: number) => Promise<JsonRpcNotification>
  kill: (signal?: NodeJS.Signals) => void
  waitForExit: (timeoutMs?: number) => Promise<number | null>
}

export function spawnRelay(entryPath: string, args: string[] = []): RelayProcess {
  const proc = spawn('node', [entryPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const responses: (JsonRpcResponse | JsonRpcNotification)[] = []
  let nextSeq = 1
  let sentinelResolved = false
  let stdoutBuffer = Buffer.alloc(0)
  let sentinelResolve: () => void
  let decoderActive = false

  const sentinelReceived = new Promise<void>((resolve) => {
    sentinelResolve = resolve
  })

  const decoder = new FrameDecoder((frame) => {
    if (frame.type !== MessageType.Regular) {
      return
    }
    try {
      const msg = parseJsonRpcMessage(frame.payload)
      responses.push(msg as JsonRpcResponse | JsonRpcNotification)
    } catch {
      /* skip malformed */
    }
  })

  proc.stdout!.on('data', (chunk: Buffer) => {
    if (!sentinelResolved) {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      const sentinelBuf = Buffer.from(RELAY_SENTINEL, 'utf-8')
      const idx = stdoutBuffer.indexOf(sentinelBuf)
      if (idx !== -1) {
        sentinelResolved = true
        decoderActive = true
        sentinelResolve()
        const remainder = stdoutBuffer.subarray(idx + sentinelBuf.length)
        if (remainder.length > 0) {
          decoder.feed(remainder)
        }
      }
    } else if (decoderActive) {
      decoder.feed(chunk)
    }
  })

  proc.stderr!.on('data', () => {
    /* drain */
  })

  const send = (method: string, params?: Record<string, unknown>): number => {
    const id = nextSeq++
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    proc.stdin!.write(encodeJsonRpcFrame(req, id, 0))
    return id
  }

  const sendNotification = (method: string, params?: Record<string, unknown>): void => {
    const seq = nextSeq++
    const notif: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    }
    proc.stdin!.write(encodeJsonRpcFrame(notif, seq, 0))
  }

  const waitForResponse = (id: number, timeoutMs = 5000): Promise<JsonRpcResponse> => {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        const found = responses.find((r) => 'id' in r && r.id === id) as JsonRpcResponse | undefined
        if (found) {
          resolve(found)
          return
        }
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for response id=${id}`))
          return
        }
        setTimeout(check, 10)
      }
      check()
    })
  }

  const waitForNotification = (method: string, timeoutMs = 5000): Promise<JsonRpcNotification> => {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const seen = responses.length
      const check = () => {
        for (let i = seen; i < responses.length; i++) {
          const r = responses[i]
          if ('method' in r && r.method === method) {
            resolve(r as JsonRpcNotification)
            return
          }
        }
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for notification "${method}"`))
          return
        }
        setTimeout(check, 10)
      }
      check()
    })
  }

  const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
    proc.kill(signal)
  }

  const waitForExit = (timeoutMs = 5000): Promise<number | null> => {
    return new Promise((resolve, reject) => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode)
        return
      }
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for process exit'))
      }, timeoutMs)
      proc.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  return {
    proc,
    responses,
    sentinelReceived,
    send,
    sendNotification,
    waitForResponse,
    waitForNotification,
    kill,
    waitForExit
  }
}
