import { isMainThread, parentPort, Worker } from 'node:worker_threads'
import { handleOpenCodeSqliteRequest } from './session-scanner-opencode-sqlite-dispatch'
import type { OpenCodeSqliteWorkerRequest } from './session-scanner-opencode-sqlite-worker-protocol'
import {
  createOpenCodeSqliteLineDecoder,
  encodeOpenCodeSqliteFrame,
  OPENCODE_SQLITE_PROCESS_MAX_TIMEOUT_MS,
  OPENCODE_SQLITE_REQUEST_MAX_BYTES,
  OPENCODE_SQLITE_RESPONSE_MAX_BYTES
} from './session-scanner-opencode-sqlite-process-framing'

function validRequest(value: unknown): value is OpenCodeSqliteWorkerRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !Number.isSafeInteger(value.id) ||
    !('kind' in value) ||
    ('agent' in value && value.agent !== 'opencode2') ||
    ('timeoutMs' in value &&
      (typeof value.timeoutMs !== 'number' ||
        !Number.isFinite(value.timeoutMs) ||
        value.timeoutMs <= 0))
  ) {
    return false
  }
  if (value.kind === 'list') {
    return (
      'dbPaths' in value &&
      Array.isArray(value.dbPaths) &&
      value.dbPaths.every((path) => typeof path === 'string') &&
      'limit' in value &&
      (value.limit === null ||
        (typeof value.limit === 'number' && Number.isSafeInteger(value.limit) && value.limit >= 0))
    )
  }
  return (
    (value.kind === 'parse' || value.kind === 'capture') &&
    'dbPath' in value &&
    typeof value.dbPath === 'string' &&
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'platform' in value &&
    typeof value.platform === 'string' &&
    [
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd'
    ].includes(value.platform) &&
    (!('fullFirstUserPrompt' in value) || typeof value.fullFirstUserPrompt === 'boolean')
  )
}

if (!isMainThread) {
  const port = parentPort
  if (!port) {
    throw new Error('Missing OpenCode SQLite process worker port.')
  }
  port.on('message', (request: OpenCodeSqliteWorkerRequest) => {
    void handleOpenCodeSqliteRequest(request).then((response) => {
      try {
        port.postMessage(encodeOpenCodeSqliteFrame(response, OPENCODE_SQLITE_RESPONSE_MAX_BYTES))
      } catch {
        port.postMessage(
          `${JSON.stringify({
            id: request.id,
            ok: false,
            error: 'OpenCode SQLite response exceeds its byte limit.'
          })}\n`
        )
      }
    })
  })
} else {
  // Keep stdin and the hard deadline responsive while SQLite blocks its worker.
  const worker = new Worker(__filename)
  let activeId: number | null = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  const stop = (code: number): never => process.exit(code)
  worker.on('error', () => stop(1))
  worker.on('exit', () => stop(1))
  worker.on('message', (line: string) => {
    clearTimeout(deadline)
    activeId = null
    process.stdout.write(line)
  })
  const decode = createOpenCodeSqliteLineDecoder(OPENCODE_SQLITE_REQUEST_MAX_BYTES, (line) => {
    const request: unknown = JSON.parse(line)
    if (!validRequest(request) || activeId !== null) {
      return stop(1)
    }
    activeId = request.id
    deadline = setTimeout(
      () => stop(124),
      Math.min(request.timeoutMs ?? 30_000, OPENCODE_SQLITE_PROCESS_MAX_TIMEOUT_MS)
    )
    worker.postMessage(request)
  })
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      decode(chunk)
    } catch {
      stop(1)
    }
  })
  process.stdin.on('end', () => stop(0))
  process.stdin.on('error', () => stop(1))
  process.stdout.on('error', () => stop(1))
}
