// What the local webhook store keeps, the ids and keys it makes in Orca Cloud's formats, and how it writes.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as z from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import type {
  WebhookCallRow as WebhookCallRowSchema,
  WebhookView
} from '../../../shared/connector-webhook-routes'
import {
  WEBHOOK_CALL_STATES,
  WEBHOOK_HOOK_ID_PATTERN,
  type WebhookCallState
} from '../../../shared/connector-webhook-contract'
import { isMissingFileError } from '../../runtime/rpc/server/pairing/device-registry-corruption'

export const LocalHook = lazyZodSchema(() =>
  z.object({
    hookId: z.string().regex(WEBHOOK_HOOK_ID_PATTERN),
    automationId: z.string().min(1),
    botId: z.string().min(1),
    state: z.enum(['live', 'paused']),
    epoch: z.number().int().nonnegative(),
    keyGeneration: z.number().int().nonnegative(),
    key: z.string().min(1),
    previousKey: z.string().min(1).optional(),
    previousKeyExpiresAt: z.number().nullable(),
    mintOperationId: z.string().min(1),
    rotateOperationId: z.string().optional(),
    rotateCancelled: z.number().int().nonnegative().optional(),
    lastCall: z.object({ at: z.number(), state: z.enum(WEBHOOK_CALL_STATES) }).nullable()
  })
)
export type LocalHook = z.infer<typeof LocalHook>

export const LocalCall = lazyZodSchema(() =>
  z.object({
    callId: z.string().min(1),
    hookId: z.string().min(1),
    receivedAt: z.number(),
    state: z.enum(WEBHOOK_CALL_STATES),
    // The hook's epoch when the call came in; a pause since then refuses it.
    epoch: z.number().int().nonnegative().optional(),
    subject: z.string().optional(),
    sample: z.literal(true).optional(),
    sampleOperationId: z.string().optional(),
    runId: z.string().optional(),
    reason: z.string().optional(),
    hasEnvelope: z.boolean()
  })
)
export type LocalCall = z.infer<typeof LocalCall>

const Counter = lazyZodSchema(() =>
  z.object({
    hookId: z.string().min(1),
    kind: z.enum(['refused', 'over_budget', 'duplicate']),
    minute: z.number(),
    count: z.number().int().positive()
  })
)
export type LocalCounterKind = z.infer<typeof Counter>['kind']
type LocalCounter = z.infer<typeof Counter>
type WebhookCallRow = z.infer<typeof WebhookCallRowSchema>

export const StoredLocalWebhooks = lazyZodSchema(() =>
  z.object({
    hooks: z.array(LocalHook),
    calls: z.array(LocalCall),
    counters: z.array(Counter),
    deliveries: z.array(z.object({ hookId: z.string(), id: z.string(), at: z.number() }))
  })
)
export type StoredLocalWebhooks = z.infer<typeof StoredLocalWebhooks>

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Random letters and digits; 248 of 256 byte values are kept, so each is uniform. */
function randomAlphanumeric(length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) {
        out += ALPHANUMERIC[byte % ALPHANUMERIC.length]
      }
    }
  }
  return out
}

// The id and key formats Orca Cloud mints (cloud/packages/connector-contract/src/webhook-names.ts).
export const newHookId = (): string => `wh_${randomAlphanumeric(16)}`
export const newCallId = (): string => `call_${randomAlphanumeric(20)}`
export const newWebhookKey = (): string => `orcawh_${randomBytes(32).toString('base64url')}`

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

/** Whether `candidate` is `key`, in time that doesn't depend on where they differ. */
export function keyMatches(candidate: string, key: string): boolean {
  return timingSafeEqual(digest(candidate), digest(key))
}

/** Replaces the file whole, readable by this user only; a crash leaves the old file or the new one. */
export async function writeOwnerOnlyFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staged = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(staged, contents, { mode: 0o600, flag: 'wx' })
    await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
}

/** A hook's calls and counted requests as its call history lists them, newest first. */
export function historyRows(calls: LocalCall[], counters: LocalCounter[]): WebhookCallRow[] {
  const rows = [
    ...calls.map((call): WebhookCallRow => ({
      kind: 'call',
      callId: call.callId,
      receivedAt: call.receivedAt,
      state: call.state,
      ...(call.sample ? { sample: true as const } : {}),
      ...(call.runId ? { runId: call.runId } : {}),
      ...(call.reason ? { reason: call.reason } : {})
    })),
    ...counters.map(({ kind, minute, count }): WebhookCallRow => ({ kind, minute, count }))
  ]
  const at = (row: WebhookCallRow) => (row.kind === 'call' ? row.receivedAt : row.minute)
  return rows.sort((a, b) => at(b) - at(a))
}

/** States of a call admitted but not yet started on the host: what a stop-now rotation cancels. */
export const PENDING: readonly WebhookCallState[] = ['queued', 'delivered']
export const isPending = (call: LocalCall): boolean => PENDING.includes(call.state) && !call.runId

/** A hook as every route answering one returns it; never its key. */
export function hookView(
  hook: LocalHook,
  pendingCalls: number,
  baseUrl: string,
  now: number
): WebhookView {
  const previousLive = hook.previousKey && (hook.previousKeyExpiresAt ?? 0) > now
  return {
    hookId: hook.hookId,
    automationId: hook.automationId,
    botId: hook.botId,
    state: hook.state,
    epoch: hook.epoch,
    hostGen: 1,
    keyGeneration: hook.keyGeneration,
    url: `${baseUrl}/hooks/${hook.hookId}`,
    adapter: null,
    previousKeyExpiresAt: previousLive ? hook.previousKeyExpiresAt : null,
    lastCall: hook.lastCall ? { ...hook.lastCall, signatureValid: false } : null,
    pendingCalls
  }
}

/** A sender's delivery id as the store keeps it: hashed, so the file never holds what was sent. */
export const deliveryHash = (deliveryId: string): string =>
  createHash('sha256').update(deliveryId).digest('hex')

// Counted requests are kept a week.
const COUNTER_MS = 7 * 24 * 60 * 60 * 1000

/** The counters with one more request of this kind in the current minute; week-old ones dropped. */
export function counted(
  counters: LocalCounter[],
  hookId: string,
  kind: LocalCounterKind,
  now: number
): LocalCounter[] {
  const minute = Math.floor(now / 60_000) * 60_000
  const kept = counters.filter((counter) => counter.minute > now - COUNTER_MS)
  const counter = kept.find(
    (entry) => entry.hookId === hookId && entry.kind === kind && entry.minute === minute
  )
  if (counter) {
    counter.count++
  } else {
    kept.push({ hookId, kind, minute, count: 1 })
  }
  return kept
}

/** The store's file; empty when there is none yet. An unreadable file is kept aside, never
 *  overwritten, and a failed read throws, so a later write can't replace the hooks it holds. */
export async function loadLocalWebhooks(path: string): Promise<StoredLocalWebhooks> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFileError(error)) {
      return { hooks: [], calls: [], counters: [], deliveries: [] }
    }
    throw error
  }
  try {
    return StoredLocalWebhooks.parse(JSON.parse(text))
  } catch {
    const aside = `${path}.unreadable-${Date.now()}`
    await rename(path, aside)
    console.warn(`[webhooks] the local webhook file was unreadable; kept as ${aside}`)
    return { hooks: [], calls: [], counters: [], deliveries: [] }
  }
}

/** Calls taken but not yet handed to the host's webhooks, each with its hook. */
export function queuedCalls(data: StoredLocalWebhooks): { hook: LocalHook; call: LocalCall }[] {
  return data.calls.flatMap((call) => {
    const hook = data.hooks.find((entry) => entry.hookId === call.hookId)
    return hook && call.state === 'queued' ? [{ hook, call }] : []
  })
}
