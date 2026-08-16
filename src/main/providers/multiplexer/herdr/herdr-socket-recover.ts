import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { HerdrSocketConnection } from './herdr-socket-connection'
import type { HerdrSocketEventConnection } from './herdr-socket-events'

export function isHerdrProcessGone(error: unknown): boolean {
  if (error instanceof HerdrRuntimeError) {
    return error.code === 'herdr_unavailable'
  }
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE' || code === 'ECONNRESET') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /timed out|closed before response|not initialized|ECONNREFUSED|ENOENT/i.test(message)
}

export async function recoverHerdrSocketSession(args: {
  sessionName: string
  connectionsBySession: Map<string, HerdrSocketConnection>
  eventConnectionsBySession: Map<string, HerdrSocketEventConnection>
  recoveries: Map<string, Promise<void>>
  ensureSession: (sessionName: string) => Promise<void>
}): Promise<void> {
  const existing = args.recoveries.get(args.sessionName)
  if (existing) {
    return await existing
  }
  const pending = (async () => {
    const events = args.eventConnectionsBySession.get(args.sessionName)
    args.eventConnectionsBySession.delete(args.sessionName)
    args.connectionsBySession.delete(args.sessionName)
    await events?.disconnect()
    await args.ensureSession(args.sessionName)
  })()
  args.recoveries.set(args.sessionName, pending)
  try {
    await pending
  } finally {
    if (args.recoveries.get(args.sessionName) === pending) {
      args.recoveries.delete(args.sessionName)
    }
  }
}
