import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createIncrementalNdjsonFramer } from '../../../shared/json-stream/main-process-ndjson-framer'
import { isProviderRecord } from '../../provider-process/provider-json-record'

// dima's native client accepts up to 16 MiB per JSON frame, including a full provider catalog.
const DIMA_FRAME_BYTES = 16 * 1024 * 1024
// dima's own client steps down one refused version per new connection.
const PROTOCOL_VERSIONS = [4, 3]

export type DaemonReply = { result?: unknown; error?: unknown }
export type DaemonCall = (method: string, params: Record<string, unknown>) => Promise<DaemonReply>
type Daemon = { call: DaemonCall; close: () => void }

/** The model profile a home's daemon reports in `hello`: dima's own provider catalog, or the
 *  --model-config file it started with, by the SHA-256 of that file's bytes. */
export type DimaDaemonProfile =
  | { kind: 'product' }
  | { kind: 'configured'; modelConfigSha256: string }

/** The profile `dima [--model-config PATH]` run in `cwd` requires of the daemon it would use;
 *  rejects when the file can't be read, as dima itself then refuses to start. */
export async function dimaLaunchProfile(
  modelConfig: string | undefined,
  cwd: string | undefined
): Promise<DimaDaemonProfile> {
  if (modelConfig === undefined) {
    return { kind: 'product' }
  }
  const bytes = await readFile(resolve(cwd ?? process.cwd(), modelConfig))
  return { kind: 'configured', modelConfigSha256: createHash('sha256').update(bytes).digest('hex') }
}

function servesProfile(reported: unknown, expected: DimaDaemonProfile): boolean {
  return (
    isProviderRecord(reported) &&
    reported.kind === expected.kind &&
    (expected.kind === 'product' || reported.modelConfigSha256 === expected.modelConfigSha256)
  )
}

/** Why a launch can't use its home's running daemon: dima refuses another profile's daemon and
 *  never replaces it, so its models would not be the ones the launch runs. */
export function dimaDaemonProfileError(label: string, expected: DimaDaemonProfile): string {
  const asked =
    expected.kind === 'configured'
      ? "uses a different model profile than the --model-config in its Arguments, so dima won't launch with them"
      : "was started with a --model-config that its Arguments don't name, so dima won't launch without it"
  return `${label}'s running daemon for this home ${asked}. Use a separate --home for each --model-config, or stop that daemon once nothing uses it.`
}

/** A connection to a daemon that already listens; null when none answers. Never starts one. */
function openDaemon(endpoint: string, signal: AbortSignal): Promise<Daemon | null> {
  return new Promise((settle) => {
    if (signal.aborted) {
      settle(null)
      return
    }
    const socket = connect(endpoint)
    const pending = new Map<number, (reply: DaemonReply) => void>()
    const decoder = new StringDecoder('utf8')
    let nextId = 0
    const close = (): void => {
      socket.destroy()
    }
    signal.addEventListener('abort', close, { once: true })
    const framer = createIncrementalNdjsonFramer(
      (message) => {
        if (!isProviderRecord(message) || typeof message.id !== 'number') {
          return
        }
        const answer = pending.get(message.id)
        pending.delete(message.id)
        answer?.(message)
      },
      close,
      { maxLineBytes: DIMA_FRAME_BYTES }
    )
    socket.on('data', (chunk: Buffer) => {
      framer.feed(decoder.write(chunk))
    })
    socket.on('error', () => settle(null))
    socket.on('close', () => {
      signal.removeEventListener('abort', close)
      settle(null)
      for (const answer of pending.values()) {
        answer({ error: 'closed' })
      }
      pending.clear()
    })
    socket.once('connect', () =>
      settle({
        call: (method, params) =>
          socket.destroyed
            ? Promise.resolve({ error: 'closed' })
            : new Promise((answer) => {
                nextId += 1
                pending.set(nextId, answer)
                socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`)
              }),
        close
      })
    )
  })
}

/** Greets the daemon as dima's client does, including its model profile check. */
export async function greetDaemon(
  endpoint: string,
  signal: AbortSignal,
  profile: DimaDaemonProfile
): Promise<(Daemon & { features: string[]; servesProfile: boolean }) | null> {
  for (const protocolVersion of PROTOCOL_VERSIONS) {
    const daemon = await openDaemon(endpoint, signal)
    if (!daemon) {
      return null
    }
    const reply = await daemon.call('hello', {
      protocolVersion,
      clientKind: 'other',
      clientName: 'Orca'
    })
    const hello = isProviderRecord(reply.result) ? reply.result : undefined
    if (hello && Array.isArray(hello.features)) {
      return {
        ...daemon,
        features: hello.features.filter((name): name is string => typeof name === 'string'),
        servesProfile: servesProfile(hello.daemonProfile, profile)
      }
    }
    daemon.close()
    const refusal = isProviderRecord(reply.error) ? reply.error.data : undefined
    if (!isProviderRecord(refusal) || refusal.appError !== 'protocol_version') {
      return null
    }
  }
  return null
}
