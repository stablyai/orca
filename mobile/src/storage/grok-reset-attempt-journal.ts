import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'

const STORAGE_PREFIX = 'orca:grok-reset-credit-attempt:v1:'
const IdempotencyKeySchema = z.uuid()
const AttemptSchema = z
  .object({
    v: z.literal(1),
    hostId: z.string().min(1),
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()

export type GrokResetAttempt = z.infer<typeof AttemptSchema>

const hostMutations = new Map<string, Promise<void>>()

function digestHex(value: string): string {
  return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storageKey(hostId: string): string {
  return `${STORAGE_PREFIX}${digestHex(hostId)}`
}

async function withHostMutation<T>(hostId: string, action: () => Promise<T>): Promise<T> {
  const previous = hostMutations.get(hostId) ?? Promise.resolve()
  const operation = previous.then(action, action)
  const tail = operation.then(
    () => undefined,
    () => undefined
  )
  hostMutations.set(hostId, tail)
  try {
    return await operation
  } finally {
    if (hostMutations.get(hostId) === tail) {
      hostMutations.delete(hostId)
    }
  }
}

function parseAttempt(raw: string, hostId: string): GrokResetAttempt {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Grok reset attempt journal is unreadable')
  }
  const result = AttemptSchema.safeParse(value)
  if (!result.success || result.data.hostId !== hostId) {
    throw new Error('Grok reset attempt journal is unreadable')
  }
  return result.data
}

export function getGrokResetAttemptIdentityKey(hostId: string): string {
  return storageKey(hostId)
}

export async function getOrCreateGrokResetAttempt(
  hostId: string,
  createIdempotencyKey: () => string
): Promise<GrokResetAttempt> {
  return withHostMutation(hostId, async () => {
    const key = storageKey(hostId)
    const raw = await AsyncStorage.getItem(key)
    if (raw !== null) {
      return parseAttempt(raw, hostId)
    }
    const attempt = AttemptSchema.parse({ v: 1, hostId, idempotencyKey: createIdempotencyKey() })
    // Why: persist before RPC so an unknown outcome can only retry the same mutation.
    await AsyncStorage.setItem(key, JSON.stringify(attempt))
    return attempt
  })
}

export async function clearGrokResetAttemptAfterAuthoritativeResponse(
  attempt: GrokResetAttempt
): Promise<void> {
  await withHostMutation(attempt.hostId, async () => {
    const key = storageKey(attempt.hostId)
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      return
    }
    if (parseAttempt(raw, attempt.hostId).idempotencyKey !== attempt.idempotencyKey) {
      throw new Error('Grok reset attempt journal identity changed')
    }
    await AsyncStorage.removeItem(key)
  })
}

/** Test-only: drain in-memory queues while preserving the durable storage mock. */
export function resetGrokResetAttemptJournalForTests(): void {
  hostMutations.clear()
}
