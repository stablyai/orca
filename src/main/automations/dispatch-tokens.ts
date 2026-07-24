import { createHash, randomUUID } from 'node:crypto'

const DISPATCH_TOKEN_TTL_MS = 30 * 60_000
export const DISPATCH_TOKEN_MAX_ENTRIES = 1024

type DispatchTokenRecord = {
  dispatchIdentity: string
  expiresAt: number
  reservedBy?: string
  inFlight: boolean
}

const dispatchTokens = new Map<string, DispatchTokenRecord>()

function pruneExpiredDispatchTokens(now = Date.now()): void {
  for (const [token, record] of dispatchTokens) {
    if (record.expiresAt <= now) {
      dispatchTokens.delete(token)
    }
  }
}

function identityDigest(...parts: string[]): string {
  const digest = createHash('sha256')
  for (const part of parts) {
    digest.update(`${part.length}:`)
    digest.update(part)
  }
  return digest.digest('base64url')
}

function evictOldestUnusedDispatchTokens(): void {
  while (dispatchTokens.size >= DISPATCH_TOKEN_MAX_ENTRIES) {
    const oldestUnused = Array.from(dispatchTokens).find(([, record]) => !record.inFlight)
    if (!oldestUnused) {
      return
    }
    dispatchTokens.delete(oldestUnused[0])
  }
}

export function createAutomationDispatchToken(automationId: string, runId: string): string {
  pruneExpiredDispatchTokens()
  evictOldestUnusedDispatchTokens()
  const token = randomUUID()
  if (dispatchTokens.size >= DISPATCH_TOKEN_MAX_ENTRIES) {
    return token
  }
  dispatchTokens.set(token, {
    dispatchIdentity: identityDigest(automationId, runId),
    expiresAt: Date.now() + DISPATCH_TOKEN_TTL_MS,
    inFlight: false
  })
  return token
}

export function beginAutomationDispatchTokenUse(args: {
  automationId: string
  runId: string
  token: string
  reservationId: string
}): boolean {
  pruneExpiredDispatchTokens()
  const record = dispatchTokens.get(args.token)
  const valid =
    record?.dispatchIdentity === identityDigest(args.automationId, args.runId) &&
    record.expiresAt > Date.now()
  if (!valid) {
    return false
  }
  const reservationIdentity = identityDigest(args.reservationId)
  if (record.reservedBy !== undefined && record.reservedBy !== reservationIdentity) {
    return false
  }
  if (record.inFlight) {
    return false
  }
  record.reservedBy = reservationIdentity
  record.inFlight = true
  return true
}

export function releaseAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === identityDigest(args.reservationId)) {
    record.inFlight = false
  }
}

export function finishAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === identityDigest(args.reservationId)) {
    dispatchTokens.delete(args.token)
  }
}

export function clearAutomationDispatchTokens(automationId: string, runId: string): void {
  const dispatchIdentity = identityDigest(automationId, runId)
  for (const [token, record] of dispatchTokens) {
    if (record.dispatchIdentity === dispatchIdentity) {
      dispatchTokens.delete(token)
    }
  }
}

export function _resetAutomationDispatchTokensForTests(): void {
  dispatchTokens.clear()
}

export function _getAutomationDispatchTokenCountForTests(): number {
  return dispatchTokens.size
}
