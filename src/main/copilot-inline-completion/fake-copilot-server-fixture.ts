import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import { ContentLengthMessageDecoder, encodeContentLengthMessage } from './content-length-framing'
import type { CopilotServerProcess } from './copilot-server-process'

export type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null
}

/** Fake server that auto-answers the given methods (default: initialize) and records everything sent to it. */
export function createFakeCopilotServer(autoReplies: Record<string, unknown> = {}) {
  const replies: Record<string, unknown> = { initialize: { capabilities: {} }, ...autoReplies }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; only the members the connection touches are assigned below.
  const child = new EventEmitter() as CopilotServerProcess & EventEmitter
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() })

  const received: JsonRpcMessage[] = []
  const decoder = new ContentLengthMessageDecoder()
  stdin.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk).filter(isJsonRpcMessage)) {
      received.push(message)
      if (message.id !== undefined && message.method !== undefined && message.method in replies) {
        stdout.write(
          encodeContentLengthMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: replies[message.method]
          })
        )
      }
    }
  })

  return {
    child,
    received,
    setAutoReply(method: string, result: unknown): void {
      replies[method] = result
    },
    reply(id: number | string | undefined, result: unknown): void {
      if (id === undefined) {
        throw new Error('reply needs a request id')
      }
      stdout.write(encodeContentLengthMessage({ jsonrpc: '2.0', id, result }))
    },
    replyError(id: number | string | undefined, message: string): void {
      if (id === undefined) {
        throw new Error('replyError needs a request id')
      }
      stdout.write(encodeContentLengthMessage({ jsonrpc: '2.0', id, error: { message } }))
    },
    notify(method: string, params: unknown): void {
      stdout.write(encodeContentLengthMessage({ jsonrpc: '2.0', method, params }))
    },
    requestFromServer(id: number | string, method: string, params: unknown): void {
      stdout.write(encodeContentLengthMessage({ jsonrpc: '2.0', id, method, params }))
    },
    async waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const match = received.find(predicate)
        if (match) {
          return match
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('fake server never received the expected message')
    }
  }
}
