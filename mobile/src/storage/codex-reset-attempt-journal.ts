import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@noble/hashes/sha256'
import { z } from 'zod'
import type { CodexResetCreditExpectedScope } from '../../../src/shared/codex-reset-credit-scope'

const STORAGE_PREFIX = 'orca:codex-reset-credit-attempt:v1:'
const IdempotencyKeySchema = z.uuid()

export const CodexResetCreditExpectedScopeSchema = z
  .object({
    target: z
      .object({
        runtime: z.enum(['host', 'wsl']),
        wslDistro: z.string().min(1).max(255).nullable()
      })
      .strict(),
    accountId: z.string().min(1).max(512),
    accountRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offerRevision: z.string().startsWith('v1:').max(4_096)
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.target.runtime === 'host' && scope.target.wslDistro !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Host reset scopes cannot name a WSL distro',
        path: ['target', 'wslDistro']
      })
    }
    if (
      scope.target.runtime === 'wsl' &&
      (scope.target.wslDistro === null || scope.target.wslDistro.trim() !== scope.target.wslDistro)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'WSL reset scopes require an exact distro',
        path: ['target', 'wslDistro']
      })
    }
  })

const CodexResetAttemptSchema = z
  .object({
    v: z.literal(1),
    hostId: z.string().min(1),
    expectedScope: CodexResetCreditExpectedScopeSchema,
    idempotencyKey: IdempotencyKeySchema
  })
  .strict()

export type CodexResetAttempt = z.infer<typeof CodexResetAttemptSchema>

type AttemptIdentity = {
  hostId: string
  expectedScope: CodexResetCreditExpectedScope
}

const scopeMutations = new Map<string, Promise<void>>()

// Why: a provider attempt's forced refresh changes offerRevision even when its
// response is lost. Keep one unresolved original offer per stable account scope.
function stableAccountScopePayload({ hostId, expectedScope }: AttemptIdentity): string {
  return JSON.stringify([
    hostId,
    expectedScope.target.runtime,
    expectedScope.target.wslDistro,
    expectedScope.accountId,
    expectedScope.accountRevision
  ])
}

function digestHex(value: string): string {
  return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function storageKey(identity: AttemptIdentity): string {
  return `${STORAGE_PREFIX}${digestHex(stableAccountScopePayload(identity))}`
}

export function getCodexResetAttemptIdentityKey(identity: AttemptIdentity): string {
  return storageKey(identity)
}

function stableAccountScopesEqual(
  left: CodexResetCreditExpectedScope,
  right: CodexResetCreditExpectedScope
): boolean {
  return (
    left.target.runtime === right.target.runtime &&
    left.target.wslDistro === right.target.wslDistro &&
    left.accountId === right.accountId &&
    left.accountRevision === right.accountRevision
  )
}

function parseAttempt(raw: string, identity: AttemptIdentity): CodexResetAttempt {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Codex reset attempt journal is unreadable')
  }
  const result = CodexResetAttemptSchema.safeParse(value)
  if (
    !result.success ||
    result.data.hostId !== identity.hostId ||
    !stableAccountScopesEqual(result.data.expectedScope, identity.expectedScope)
  ) {
    throw new Error('Codex reset attempt journal is unreadable')
  }
  return result.data
}

async function withScopeMutation<T>(
  identity: AttemptIdentity,
  action: () => Promise<T>
): Promise<T> {
  const key = storageKey(identity)
  const previous = scopeMutations.get(key) ?? Promise.resolve()
  const operation = previous.then(action, action)
  const tail = operation.then(
    () => undefined,
    () => undefined
  )
  scopeMutations.set(key, tail)
  try {
    return await operation
  } finally {
    if (scopeMutations.get(key) === tail) {
      scopeMutations.delete(key)
    }
  }
}

export async function getOrCreateCodexResetAttempt(
  identity: AttemptIdentity & { createIdempotencyKey: () => string }
): Promise<CodexResetAttempt> {
  return withScopeMutation(identity, async () => {
    const key = storageKey(identity)
    const raw = await AsyncStorage.getItem(key)
    if (raw !== null) {
      return parseAttempt(raw, identity)
    }

    const idempotencyKey = identity.createIdempotencyKey()
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      throw new Error('Codex reset attempt idempotency key is invalid')
    }
    const attempt = CodexResetAttemptSchema.parse({
      v: 1,
      hostId: identity.hostId,
      expectedScope: identity.expectedScope,
      idempotencyKey
    })
    // Why: the key must survive a committed provider mutation whose response is
    // lost; no reset RPC may start until this write has completed successfully.
    await AsyncStorage.setItem(key, JSON.stringify(attempt))
    return attempt
  })
}

export async function clearCodexResetAttemptAfterAuthoritativeResponse(
  identity: AttemptIdentity & { idempotencyKey: string }
): Promise<void> {
  return withScopeMutation(identity, async () => {
    const key = storageKey(identity)
    const raw = await AsyncStorage.getItem(key)
    if (raw === null) {
      return
    }
    const current = parseAttempt(raw, identity)
    if (current.idempotencyKey !== identity.idempotencyKey) {
      throw new Error('Codex reset attempt journal identity changed')
    }
    await AsyncStorage.removeItem(key)
  })
}

/** Test-only: drain in-memory queues while preserving the durable storage mock. */
export function resetCodexResetAttemptJournalForTests(): void {
  scopeMutations.clear()
}
