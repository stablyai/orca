import { z } from 'zod'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../../../../src/shared/native-chat/native-chat-visual-directive'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../../transport/rpc-operation'
import { rpcResultVariant } from '../../../transport/rpc-operation-result-reader'
import { isMobileMethodUnavailableError } from '../../../transport/mobile-method-unavailable'
import type { RpcClient } from '../../../transport/rpc-client'

export type MobileNativeChatVisualSource = {
  client: RpcClient
  sessionId: string
}

export type MobileNativeChatVisualRead =
  | { kind: 'ready'; html: string; revision: string }
  // Definitive refusal, including unsupported hosts; discard stale cached content.
  | { kind: 'refused' }
  // No file verdict from this failure; retry may succeed.
  | { kind: 'unreachable' }

const Revision = z.string().regex(/^[0-9a-f]{16,64}$/)

const visualReadReplySchema = z.union([
  z.object({
    ok: z.literal(true),
    revision: Revision,
    html: z.string().max(NATIVE_CHAT_VISUAL_MAX_BYTES)
  }),
  z.object({ ok: z.literal(true), revision: Revision, unchanged: z.literal(true) }),
  // A newer host's error code still reads as a refusal.
  z.object({ ok: z.literal(false), error: z.string() })
])

const nativeChatVisualRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentSession.read-visual',
    method: 'agentSession.readVisual',
    acceptance: 'object-result-or-null',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('native-chat-visual', visualReadReplySchema)
  })
)

const READ_TIMEOUT_MS = 15_000
// Each entry is at most 512 KiB of UTF-8; the character bound is what caps memory.
const MAX_CACHE_ENTRIES = 16
const MAX_CACHE_CHARS = 4 * 1024 * 1024

type CachedVisual = { html: string; revision: string }

const cache = new Map<string, CachedVisual>()
const inFlight = new Map<string, Promise<MobileNativeChatVisualRead>>()

// Key by paired client so colliding session ids on different hosts cannot share visuals.
const clientKeys = new WeakMap<RpcClient, number>()
let nextClientKey = 0

function cacheKey(source: MobileNativeChatVisualSource, file: string): string {
  let clientKey = clientKeys.get(source.client)
  if (clientKey === undefined) {
    nextClientKey += 1
    clientKey = nextClientKey
    clientKeys.set(source.client, clientKey)
  }
  return JSON.stringify([clientKey, source.sessionId, file])
}

function remember(key: string, entry: CachedVisual): void {
  cache.delete(key)
  cache.set(key, entry)
  let chars = 0
  for (const value of cache.values()) {
    chars += value.html.length
  }
  for (const [oldKey, value] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && chars <= MAX_CACHE_CHARS) {
      break
    }
    if (oldKey === key) {
      continue
    }
    cache.delete(oldKey)
    chars -= value.html.length
  }
}

export function cachedMobileNativeChatVisual(
  source: MobileNativeChatVisualSource,
  file: string
): CachedVisual | null {
  return cache.get(cacheKey(source, file)) ?? null
}

async function readOnce(
  source: MobileNativeChatVisualSource,
  file: string,
  key: string
): Promise<MobileNativeChatVisualRead> {
  const known = cache.get(key)
  let response
  try {
    response = await nativeChatVisualRead.request(
      source.client,
      {
        sessionId: source.sessionId,
        file,
        ...(known ? { knownRevision: known.revision } : {})
      },
      { timeoutMs: READ_TIMEOUT_MS, budgetSpansConnect: true }
    )
  } catch {
    return { kind: 'unreachable' }
  }
  if (!response.ok && isMobileMethodUnavailableError(response.error.code, response.error.message)) {
    // An older host (its mobile allowlist answers `forbidden`): asking again will not help.
    return { kind: 'refused' }
  }
  const reply = nativeChatVisualRead.interpret(response)
  if (reply === null) {
    // An unreadable/error reply proves nothing about the file.
    return { kind: 'unreachable' }
  }
  if (!reply.ok) {
    // A host refusal invalidates the cached bytes.
    cache.delete(key)
    return { kind: 'refused' }
  }
  if ('html' in reply) {
    remember(key, { html: reply.html, revision: reply.revision })
    return { kind: 'ready', html: reply.html, revision: reply.revision }
  }
  // An unchanged reply must name the cached revision we sent; any other revision is inconsistent.
  if (known && known.revision === reply.revision) {
    remember(key, known)
    return { kind: 'ready', html: known.html, revision: known.revision }
  }
  cache.delete(key)
  return { kind: 'unreachable' }
}

export function readMobileNativeChatVisual(
  source: MobileNativeChatVisualSource,
  file: string
): Promise<MobileNativeChatVisualRead> {
  const key = cacheKey(source, file)
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const read = readOnce(source, file, key).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, read)
  return read
}

export function resetMobileNativeChatVisualCacheForTest(): void {
  cache.clear()
  inFlight.clear()
}
