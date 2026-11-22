import { randomUUID } from 'node:crypto'

const DISPATCH_TOKEN_TTL_MS = 30 * 60_000
export const MAX_AUTOMATION_DISPATCH_TOKENS = 1024

type DispatchTokenRecord = {
  automationId: string
  runId: string
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

function trimDispatchTokens(): void {
  while (dispatchTokens.size > MAX_AUTOMATION_DISPATCH_TOKENS) {
    const oldestEvictable = [...dispatchTokens].find(([, record]) => !record.inFlight)
    if (!oldestEvictable) {
      return
    }
    dispatchTokens.delete(oldestEvictable[0])
  }
}

export function createAutomationDispatchToken(automationId: string, runId: string): string {
  pruneExpiredDispatchTokens()
  const token = randomUUID()
  dispatchTokens.set(token, {
    automationId,
    runId,
    expiresAt: Date.now() + DISPATCH_TOKEN_TTL_MS,
    inFlight: false
  })
  trimDispatchTokens()
  return token
}

export function getAutomationDispatchTokenCountForTests(): number {
  return dispatchTokens.size
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
    record?.automationId === args.automationId &&
    record.runId === args.runId &&
    record.expiresAt > Date.now()
  if (!valid) {
    return false
  }
  if (record.reservedBy !== undefined && record.reservedBy !== args.reservationId) {
    return false
  }
  if (record.inFlight) {
    return false
  }
  record.reservedBy = args.reservationId
  record.inFlight = true
  return true
}

export function releaseAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === args.reservationId) {
    record.inFlight = false
  }
}

export function finishAutomationDispatchTokenUse(args: {
  token: string
  reservationId: string
}): void {
  const record = dispatchTokens.get(args.token)
  if (record?.reservedBy === args.reservationId) {
    dispatchTokens.delete(args.token)
  }
}

export function clearAutomationDispatchTokens(automationId: string, runId: string): void {
  for (const [token, record] of dispatchTokens) {
    if (record.automationId === automationId && record.runId === runId) {
      dispatchTokens.delete(token)
    }
  }
}
