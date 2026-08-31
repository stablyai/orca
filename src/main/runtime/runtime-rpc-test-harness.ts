import { createConnection, type Socket } from 'node:net'
import type { OrchestrationDb } from './orchestration/db'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

export async function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      resolve(JSON.parse(message) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(withCurrentOrchestrationContract(request))}\n`)
    })
  })
}

// Why: long-poll keepalive tests need every frame, not just the first, because
// we need to count `_keepalive` frames before the terminal success/failure.
// Also exposes the socket so tests can close it mid-wait to exercise the
// long-poll counter decrement path.
export type FramedSession = {
  socket: Socket
  frames: Record<string, unknown>[]
  done: Promise<void>
}

export function openFramedSession(
  endpoint: string,
  request: Record<string, unknown>
): FramedSession {
  const frames: Record<string, unknown>[] = []
  const socket = createConnection(endpoint)
  let buffer = ''
  socket.setEncoding('utf8')
  const done = new Promise<void>((resolve, reject) => {
    socket.once('error', (err) => {
      // Why: ECONNRESET is expected when we deliberately destroy the socket
      // mid-wait to probe the counter decrement; surface other errors.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve()
        return
      }
      reject(err)
    })
    socket.on('close', () => resolve())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (raw) {
          const frame = JSON.parse(raw) as Record<string, unknown>
          frames.push(frame)
          // Why: the server leaves the socket open after writing the terminal
          // frame (short RPCs expect the client to close); close the client
          // side so `done` resolves once we've captured the response.
          if (frame._keepalive !== true) {
            socket.end()
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(withCurrentOrchestrationContract(request))}\n`)
    })
  })
  return { socket, frames, done }
}

export function withCurrentOrchestrationContract(
  request: Record<string, unknown>
): Record<string, unknown> {
  return typeof request.method === 'string' && request.method.startsWith('orchestration.')
    ? { ...request, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
    : request
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await sleep(20)
  }
}

export function seedSupervisedAskWorkers(db: OrchestrationDb, workerHandles: string[]): void {
  const run = db.createRun({
    objective: 'Exercise ask admission',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  })
  for (const workerHandle of workerHandles) {
    const task = db.createTask({ spec: 'Wait for coordinator input', runId: run.id })
    createRootDispatch(db, task.id, workerHandle)
  }
}
