import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createIncrementalNdjsonFramer } from '../../../shared/json-stream/main-process-ndjson-framer'
import {
  dimaCatalogModels,
  dimaCatalogReplyModels,
  dimaQueryPageModels,
  type DimaListedModel
} from '../../../shared/agent-session/options/model-catalog/dima-model-list-probe'
import type { AgentModelProbeSpec } from '../../../shared/agent-session/options/model-catalog/agent-model-probe-spec'
import { isProviderRecord } from '../../provider-process/provider-json-record'
import { staticModelDiscoveryResult } from './commit-message-model-discovery-policy'
import type { DiscoverCommitMessageModelsResult } from '../source-control-text-generation-types'

// dima's native client accepts up to 16 MiB per JSON frame, including a full provider catalog.
const DIMA_FRAME_BYTES = 16 * 1024 * 1024
const PROBE_TIMEOUT_MS = 10_000
const PAGE_LIMIT = 128
const MAX_PAGES = 64
// dima's own client steps down one refused version per new connection.
const PROTOCOL_VERSIONS = [4, 3]

type DaemonReply = { result?: unknown; error?: unknown }
type DaemonCall = (method: string, params: Record<string, unknown>) => Promise<DaemonReply>
type Daemon = { call: DaemonCall; close: () => void }

function envLookup(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  return platform === 'win32'
    ? Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value)?.[1]
    : env[name]
}

/** Where a running dima daemon listens, as dima's client derives it; null when dima never ran. */
export async function dimaDaemonEndpoint(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform,
  productHome?: string
): Promise<string | null> {
  const configured = productHome ?? envLookup(env, 'DIMCODE_HOME', platform)
  const userHome = envLookup(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform)
  // `dima` comes from dimcode-alpha, whose builds default to ~/.dimcode-alpha.
  const home = configured
    ? resolve(cwd || userHome || homedir(), configured)
    : join(userHome || homedir(), '.dimcode-alpha')
  let nativeHome: string
  try {
    nativeHome = await realpath(join(home, 'rust'))
  } catch {
    return null
  }
  if (platform !== 'win32') {
    const endpoint = join(nativeHome, 'daemon.sock')
    // dima accepts only a private socket owned by the effective user. Reject symlinks too.
    try {
      const file = await lstat(endpoint)
      const parent = await lstat(nativeHome)
      const uid = process.geteuid?.()
      return parent.isDirectory() &&
        parent.uid === uid &&
        !(parent.mode & 0o077) &&
        file.isSocket() &&
        file.uid === uid &&
        !(file.mode & 0o077)
        ? endpoint
        : null
    } catch {
      return null
    }
  }
  // Rust's canonical path keeps the verbatim prefix that Node's realpath drops.
  const verbatim = nativeHome.startsWith('\\\\')
    ? `\\\\?\\UNC\\${nativeHome.slice(2)}`
    : `\\\\?\\${nativeHome}`
  const key = createHash('sha256').update(`dimcode:${verbatim}`).digest('hex')
  return `\\\\.\\pipe\\dim-rust-${key.slice(0, 32)}`
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

async function greetDaemon(
  endpoint: string,
  signal: AbortSignal
): Promise<(Daemon & { features: string[] }) | null> {
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
    const features = isProviderRecord(reply.result) ? reply.result.features : undefined
    if (Array.isArray(features)) {
      return {
        ...daemon,
        features: features.filter((name): name is string => typeof name === 'string')
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

function result(reply: DaemonReply, method: string): unknown {
  if (reply.error !== undefined) {
    throw new Error(`${method} failed`)
  }
  return reply.result
}

/** The read dima's own model picker makes (alpha.29+). */
async function querySelectableModels(call: DaemonCall): Promise<DimaListedModel[]> {
  const models: DimaListedModel[] = []
  let after: unknown = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = { selectableOnly: true, limit: PAGE_LIMIT, ...(after ? { after } : {}) }
    const reply = result(await call('provider.models.query', params), 'provider.models.query')
    if (!isProviderRecord(reply) || !Array.isArray(reply.models)) {
      throw new Error('Invalid model page')
    }
    const listed = dimaQueryPageModels(reply)
    models.push(...listed.models)
    if (!listed.next) {
      return models
    }
    if (JSON.stringify(listed.next) === JSON.stringify(after)) {
      throw new Error('Repeated model-list cursor')
    }
    after = listed.next
  }
  throw new Error('Model listing exceeded the page limit')
}

type ListedProvider = { providerId: string; providerName?: string; enabled: boolean }

function listedProviders(value: unknown): ListedProvider[] {
  const rows = isProviderRecord(value) ? value.providers : value
  return (Array.isArray(rows) ? rows : []).flatMap((row: unknown): ListedProvider[] =>
    isProviderRecord(row) && typeof row.providerId === 'string'
      ? [
          {
            providerId: row.providerId,
            ...(typeof row.displayName === 'string' ? { providerName: row.displayName } : {}),
            enabled: row.enabled === true
          }
        ]
      : []
  )
}

/** Older daemons' picker read: enabled static providers and signed-in accounts, then each stored catalog. */
async function readProviderCatalogs(call: DaemonCall) {
  let partial = false
  const providers = new Map<string, string | undefined>()
  for (const provider of listedProviders(
    result(await call('provider.list', {}), 'provider.list')
  )) {
    if (provider.enabled) {
      providers.set(provider.providerId, provider.providerName)
    }
  }
  // provider.list leaves out managed accounts. Older daemons may have no account API.
  const managed = await call('account.providers', {})
  if (managed.error !== undefined) {
    const data = isProviderRecord(managed.error) ? managed.error.data : undefined
    partial = !isProviderRecord(data) || data.appError !== 'unknown_method'
  }
  for (const provider of listedProviders(managed.result)) {
    if (providers.has(provider.providerId)) {
      continue
    }
    const status = await call('account.status', { providerId: provider.providerId })
    if (status.error !== undefined) {
      partial = true
    } else if (isProviderRecord(status.result) && status.result.account != null) {
      providers.set(provider.providerId, provider.providerName)
    }
  }
  const models: DimaListedModel[] = []
  for (const [providerId, providerName] of providers) {
    const reply = await call('provider.catalog', { providerId })
    // Like alpha.25's /models: one unreadable provider must not hide another's selectable rows.
    if (reply.error !== undefined) {
      partial = true
    } else {
      models.push(...dimaCatalogReplyModels({ providerId, providerName }, reply.result))
    }
  }
  if (partial && !models.length) {
    throw new Error('No complete model listing')
  }
  return { models, partial }
}

/** Read the execution host's selectable models without creating a session or sending a prompt. */
export async function discoverDimaModels(
  spec: AgentModelProbeSpec,
  input: {
    env: NodeJS.ProcessEnv | undefined
    cwd?: string
    wslDistro?: string
    productHome?: string
    startDaemon?: (signal: AbortSignal) => Promise<boolean>
  }
): Promise<DiscoverCommitMessageModelsResult> {
  if (input.wslDistro) {
    return { success: false, error: `${spec.label} model listing is not available in WSL.` }
  }
  const env = input.env ?? process.env
  // dima's direct endpoint mode refuses --provider. Only its configured default can run.
  if (
    envLookup(env, 'DIM_BASE_URL', process.platform) ||
    envLookup(env, 'DIM_API_FORMAT', process.platform)
  ) {
    return staticModelDiscoveryResult(spec, [], spec.defaultModelId, 'probe')
  }
  const connectToDaemon = async (signal: AbortSignal) => {
    const endpoint = await dimaDaemonEndpoint(env, input.cwd, process.platform, input.productHome)
    return endpoint ? greetDaemon(endpoint, signal) : null
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), PROBE_TIMEOUT_MS)
  let daemon: Awaited<ReturnType<typeof greetDaemon>> = null
  try {
    daemon = await connectToDaemon(deadline.signal)
    if (!daemon && !deadline.signal.aborted && (await input.startDaemon?.(deadline.signal))) {
      daemon = await connectToDaemon(deadline.signal)
    }
    if (!daemon) {
      return {
        success: false,
        error: `${spec.label} could not reach its model catalog. Check the dima installation and refresh the list.`
      }
    }
    const { models, partial } = daemon.features.includes('provider.models.query')
      ? { models: await querySelectableModels(daemon.call), partial: false }
      : await readProviderCatalogs(daemon.call)
    return {
      ...staticModelDiscoveryResult(spec, dimaCatalogModels(models), spec.defaultModelId, 'probe'),
      ...(partial ? { partial: true } : {})
    }
  } catch {
    return { success: false, error: `${spec.label} could not read its model list.` }
  } finally {
    clearTimeout(timer)
    daemon?.close()
  }
}
