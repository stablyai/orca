import { PassThrough } from 'node:stream'
import { z } from 'zod'

const frameSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional()
})
export type FakeFrame = z.infer<typeof frameSchema>
type Handler = (frame: FakeFrame) => void

export class AcpScriptedAgent {
  readonly stdout = new PassThrough()
  readonly stdin = new PassThrough()
  readonly frames: FakeFrame[] = []
  private readonly methods = new Map<string, Handler>()
  private readonly requests = new Map<string | number | null, (response: FakeFrame) => void>()
  private suffix = ''

  constructor() {
    this.stdin.setEncoding('utf8').on('data', (chunk: string) => {
      this.suffix += chunk
      let newline: number
      while ((newline = this.suffix.indexOf('\n')) !== -1) {
        const frame = frameSchema.parse(JSON.parse(this.suffix.slice(0, newline)))
        this.suffix = this.suffix.slice(newline + 1)
        this.frames.push(frame)
        if (frame.method !== undefined) {
          this.methods.get(frame.method)?.(frame)
        } else if (frame.id !== undefined) {
          this.requests.get(frame.id)?.(frame)
          this.requests.delete(frame.id)
        }
      }
    })
  }

  on(method: string, handler: Handler): void {
    this.methods.set(method, handler)
  }
  reply(frame: FakeFrame, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: frame.id, result })
  }
  fail(frame: FakeFrame, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id: frame.id, error: { code, message, data } })
  }
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }
  request(id: string | number | null, method: string, params: unknown): Promise<FakeFrame> {
    return new Promise((resolve) => {
      this.requests.set(id, resolve)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  send(frame: FakeFrame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }
  close(): void {
    this.stdout.end()
    this.stdin.end()
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let fulfill: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    fulfill = resolve
  })
  return {
    promise,
    resolve: (value) => {
      fulfill?.(value)
    }
  }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
