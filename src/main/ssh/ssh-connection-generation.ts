import { randomBytes } from 'node:crypto'
import { toSshExecutionHostId } from '../../shared/execution-host'

const SESSION_COUNTER_BITS = 13
const SESSION_COUNTER_STRIDE = 2 ** SESSION_COUNTER_BITS
const MAX_SESSION_SCOPE = 2 ** (53 - SESSION_COUNTER_BITS) - 1

function createSessionScope(): number {
  return randomBytes(5).readUIntBE(0, 5)
}

let sessionGenerationBase = 0
let sessionInitialized = false
const connectionGenerationByTarget = new Map<string, number>()
const usedSessionScopes = new Set<number>()

function assertGenerationInCurrentSession(generation: number): void {
  if (
    !Number.isSafeInteger(generation) ||
    generation < sessionGenerationBase ||
    generation - sessionGenerationBase >= SESSION_COUNTER_STRIDE
  ) {
    throw new Error('SSH connection generation exhausted for this runtime session')
  }
}

export function getSshConnectionGeneration(targetId: string): number {
  return connectionGenerationByTarget.get(targetId) ?? sessionGenerationBase
}

export function initializeSshConnectionGenerationSession(): void {
  if (sessionInitialized) {
    return
  }
  const sessionScope = createSessionScope()
  // Why: randomize the process scope so a replacement HUB does not predictably reuse the prior target/counter token.
  sessionGenerationBase = sessionScope * SESSION_COUNTER_STRIDE
  usedSessionScopes.add(sessionScope)
  sessionInitialized = true
}

export function advanceSshConnectionGeneration(targetId: string): number {
  let next = getSshConnectionGeneration(targetId) + 1
  if (next - sessionGenerationBase >= SESSION_COUNTER_STRIDE) {
    let nextSessionScope =
      (sessionGenerationBase / SESSION_COUNTER_STRIDE + 1) % (MAX_SESSION_SCOPE + 1)
    while (usedSessionScopes.has(nextSessionScope)) {
      nextSessionScope = (nextSessionScope + 1) % (MAX_SESSION_SCOPE + 1)
    }
    usedSessionScopes.add(nextSessionScope)
    sessionGenerationBase = nextSessionScope * SESSION_COUNTER_STRIDE
    // Why: changing the scope must revoke tokens for every target, not only the target that exhausted its counter.
    connectionGenerationByTarget.clear()
    next = sessionGenerationBase + 1
  }
  assertGenerationInCurrentSession(next)
  connectionGenerationByTarget.set(targetId, next)
  return next
}

export function setSshConnectionGeneration(targetId: string, generation: number): void {
  assertGenerationInCurrentSession(generation)
  connectionGenerationByTarget.set(targetId, generation)
}

export function resetSshConnectionGenerations(sessionScope = 0): void {
  if (!Number.isSafeInteger(sessionScope) || sessionScope < 0 || sessionScope > MAX_SESSION_SCOPE) {
    throw new Error('Invalid SSH connection generation session scope')
  }
  sessionGenerationBase = sessionScope * SESSION_COUNTER_STRIDE
  sessionInitialized = true
  connectionGenerationByTarget.clear()
  usedSessionScopes.clear()
  usedSessionScopes.add(sessionScope)
}

export function assertSshMutationExpectation(
  connectionId: string | undefined,
  expectedTargetId: string | undefined,
  expectedGeneration: number | undefined,
  expectedExecutionHostId?: string
): void {
  const actualExecutionHostId = connectionId ? toSshExecutionHostId(connectionId) : 'local'
  if (expectedExecutionHostId !== undefined && expectedExecutionHostId !== actualExecutionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  const hasExpectation = expectedTargetId !== undefined || expectedGeneration !== undefined
  if (!connectionId) {
    if (hasExpectation) {
      throw new Error('SSH connection changed; refresh and try again')
    }
    return
  }
  if (
    expectedTargetId !== connectionId ||
    expectedGeneration === undefined ||
    expectedGeneration !== getSshConnectionGeneration(connectionId)
  ) {
    throw new Error('SSH connection changed; refresh and try again')
  }
}
