import { randomBytes } from 'node:crypto'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  resolveExecutableCommand,
  withCliRuntimeOnPath
} from '../../shared/node-cli-command-resolution'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'
import {
  isRecord,
  mapMuseUsage,
  parseMuseSubscriptionUsage,
  type MuseSubscriptionUsage
} from './muse-usage-response'

// Why long: the probe waits on one real (tiny) model turn.
const PROBE_TIMEOUT_MS = 90_000
// Why: Muse only reports usage after a model reply, so each real probe spends one request.
export const MUSE_MIN_PROBE_INTERVAL_MS = 14 * 60 * 1000
const PROBE_PROMPT = 'Reply with exactly: ok'

type JsonRpcMessage = Record<string, unknown>

export type MuseProbeChild = {
  stdin: { write(data: string): unknown; end(): unknown }
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}

let lastSnapshot: ProviderRateLimits | null = null
let inFlight: Promise<ProviderRateLimits> | null = null

export function resetMuseUsageCacheForTests(): void {
  lastSnapshot = null
  inFlight = null
}

function result(
  status: 'unavailable' | 'error',
  error: string,
  failureKind: 'cli-unavailable' | 'usage-unavailable' | 'server' | 'parse' | 'unknown'
): ProviderRateLimits {
  return {
    provider: 'muse',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: { source: 'cli', failureKind }
  }
}

function uuidV7(): string {
  const bytes = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** MSP over `muse serve`: handshake, ephemeral session, one minimal turn, then usage/changed or usage/read. */
export function readMuseUsageViaServe(options: {
  child: MuseProbeChild
  workspaceRoot: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<ProviderRateLimits> {
  const { child, workspaceRoot, signal } = options
  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    let nextId = 1
    let usage: MuseSubscriptionUsage | null = null
    const pending = new Map<number, (message: JsonRpcMessage) => void>()
    let onTurnCompleted: ((params: unknown) => void) | null = null

    const finish = (value: ProviderRateLimits): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        child.stdin.end()
      } catch {
        // stdin may already be closed
      }
      child.kill('SIGTERM')
      resolve(value)
    }
    const onAbort = (): void => finish(result('error', 'Muse usage probe was cancelled', 'unknown'))
    const timer = setTimeout(
      () => finish(result('error', 'Muse did not report usage in time', 'server')),
      options.timeoutMs ?? PROBE_TIMEOUT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    }
    const request = (method: string, params: unknown): Promise<JsonRpcMessage> => {
      const id = nextId++
      return new Promise((resolveRequest) => {
        pending.set(id, resolveRequest)
        send({ id, method, params })
      })
    }

    const handle = (message: JsonRpcMessage): void => {
      if (typeof message.id === 'number' && pending.has(message.id)) {
        const resolveRequest = pending.get(message.id)
        pending.delete(message.id)
        resolveRequest?.(message)
        return
      }
      if (message.method === 'usage/changed') {
        usage = parseMuseSubscriptionUsage(message.params) ?? usage
      } else if (message.method === 'turn/completed') {
        onTurnCompleted?.(message.params)
      }
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) {
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (isRecord(parsed)) {
          handle(parsed)
        }
      }
    })
    child.on('error', (error) =>
      finish(result('unavailable', `Could not start Muse: ${error.message}`, 'cli-unavailable'))
    )
    child.on('close', () => finish(result('error', 'Muse exited before reporting usage', 'server')))

    const expectOk = (message: JsonRpcMessage, step: string): JsonRpcMessage => {
      if (message.error !== undefined) {
        const detail = isRecord(message.error) ? message.error.message : undefined
        throw new Error(`${step}: ${typeof detail === 'string' ? detail : 'failed'}`)
      }
      return message
    }

    void (async () => {
      try {
        expectOk(
          await request('initialize', {
            clientInfo: { name: 'orca_usage', version: '1' }
          }),
          'initialize'
        )
        send({ method: 'initialized' })
        const started = expectOk(
          await request('session/start', {
            commandId: uuidV7(),
            workspaceRoot
          }),
          'session/start'
        )
        const session =
          isRecord(started.result) && isRecord(started.result.session)
            ? started.result.session
            : null
        const sessionId = session?.sessionId
        if (typeof sessionId !== 'string') {
          throw new Error('session/start returned no session id')
        }
        const turnDone = new Promise<unknown>((resolveTurn) => {
          onTurnCompleted = resolveTurn
        })
        expectOk(
          await request('turn/start', {
            commandId: uuidV7(),
            sessionId,
            reasoningEffort: 'none',
            input: [{ type: 'text', text: PROBE_PROMPT }]
          }),
          'turn/start'
        )
        const completed = await turnDone
        const terminal = isRecord(completed) ? completed.terminal : undefined
        if (terminal !== 'completed') {
          finish(
            result(
              'error',
              'Muse request failed — run `muse login` if your session expired',
              'server'
            )
          )
          return
        }
        if (!usage) {
          // Why: usage/changed usually lands just after turn/completed.
          await new Promise((r) => setTimeout(r, 1500))
        }
        if (!usage) {
          const read = expectOk(await request('usage/read', {}), 'usage/read')
          usage = isRecord(read.result) ? parseMuseSubscriptionUsage(read.result.usage) : null
        }
        finish(
          usage
            ? mapMuseUsage(usage)
            : result('unavailable', 'Muse did not report subscription usage', 'usage-unavailable')
        )
      } catch (error) {
        finish(result('error', error instanceof Error ? error.message : String(error), 'parse'))
      }
    })()
  })
}

async function probeMuseUsage(signal?: AbortSignal): Promise<ProviderRateLimits> {
  const command = resolveExecutableCommand('muse')
  if (!command) {
    return result('unavailable', 'Muse Code CLI is not installed', 'cli-unavailable')
  }
  const workspaceRoot = resolveHiddenRateLimitPtyCwd()
  const child = spawnProcess({
    program: command,
    args: ['serve', '--no-session-log'],
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd: workspaceRoot,
    env: withCliRuntimeOnPath(command, { ...process.env })
  })
  return readMuseUsageViaServe({ child, workspaceRoot, signal })
}

export async function fetchMuseRateLimits(
  options: { signal?: AbortSignal; now?: number; force?: boolean } = {}
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now()
  if (
    !options.force &&
    lastSnapshot?.status === 'ok' &&
    now - lastSnapshot.updatedAt < MUSE_MIN_PROBE_INTERVAL_MS
  ) {
    return lastSnapshot
  }
  inFlight ??= probeMuseUsage(options.signal).finally(() => {
    inFlight = null
  })
  const next = await inFlight
  if (next.status === 'ok') {
    lastSnapshot = next
  }
  return next
}
