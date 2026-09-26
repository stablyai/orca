import { EventEmitter } from 'node:events'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { WorkerRequestTransport } from '../lazy-worker-thread-host'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import {
  createOpenCodeSqliteLineDecoder,
  encodeOpenCodeSqliteFrame,
  OPENCODE_SQLITE_REQUEST_MAX_BYTES,
  OPENCODE_SQLITE_RESPONSE_MAX_BYTES
} from './session-scanner-opencode-sqlite-process-framing'

export type OpenCodeSqliteProcessOptions = {
  executable: string
  args: readonly string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  log?: (message: string) => void
  requestTimeoutMs?: number
  idleTeardownMs?: number
}

function createProcessTransport(options: OpenCodeSqliteProcessOptions): WorkerRequestTransport {
  const child = spawnProcess({
    program: options.executable,
    args: options.args,
    env: options.env,
    cwd: options.cwd
  })
  const events = new EventEmitter()
  let retired = false
  const fault = (error: Error): void => {
    if (!retired) {
      events.emit('error', error)
    }
  }
  const decode = createOpenCodeSqliteLineDecoder(OPENCODE_SQLITE_RESPONSE_MAX_BYTES, (line) => {
    const response: unknown = JSON.parse(line)
    if (
      typeof response !== 'object' ||
      response === null ||
      !('id' in response) ||
      !Number.isSafeInteger(response.id) ||
      !('ok' in response) ||
      typeof response.ok !== 'boolean' ||
      (!response.ok && (!('error' in response) || typeof response.error !== 'string'))
    ) {
      throw new Error('Invalid OpenCode SQLite process response.')
    }
    events.emit('message', response)
  })
  child.stdout.on('data', (chunk: Buffer) => {
    if (retired) {
      return
    }
    try {
      decode(chunk)
    } catch (error) {
      fault(error instanceof Error ? error : new Error(String(error)))
    }
  })
  // Diagnostics never share the framed response channel or accumulate in memory.
  child.stderr.resume()
  child.on('error', fault)
  child.stdin.on('error', fault)
  child.stdout.on('error', fault)
  child.stderr.on('error', fault)
  child.on('exit', (code) => {
    if (!retired) {
      events.emit('exit', code ?? 1)
    }
  })
  return Object.assign(events, {
    postMessage(request: unknown): void {
      if (retired || child.stdin.destroyed) {
        throw new Error('OpenCode SQLite reader process is unavailable.')
      }
      child.stdin.write(encodeOpenCodeSqliteFrame(request, OPENCODE_SQLITE_REQUEST_MAX_BYTES))
    },
    unref(): void {
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if ('unref' in stream && typeof stream.unref === 'function') {
          stream.unref()
        }
      }
    },
    async terminate(): Promise<number> {
      retired = true
      // EOF reaches the guest reader even when this process is an SSH/WSL launcher.
      child.stdin.end()
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
      return 0
    }
  })
}

export function createOpenCodeSqliteProcessClient(
  options: OpenCodeSqliteProcessOptions
): OpenCodeSqliteWorkerClient {
  return new OpenCodeSqliteWorkerClient({
    workerFactory: () => createProcessTransport(options),
    log: options.log,
    requestTimeoutMs: options.requestTimeoutMs,
    idleTeardownMs: options.idleTeardownMs
  })
}
