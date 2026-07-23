import { randomBytes } from 'node:crypto'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

const SESSION_COUNTER_BITS = 13
const SESSION_COUNTER_STRIDE = 2 ** SESSION_COUNTER_BITS
const MAX_SESSION_SCOPE = 2 ** (53 - SESSION_COUNTER_BITS) - 1
export const MAX_TRACKED_SSH_CONNECTION_GENERATIONS = 4_096
export const MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES = 8_192
export const MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES = 64 * 1024
export const MAX_SSH_CONNECTION_GENERATION_RETAINED_TARGET_ID_BYTES = 4 * 1024 * 1024

type SshConnectionGenerationEntry = {
  generation: number
  leaseCount: number
  targetIdBytes: number
}

export type SshConnectionGenerationLease = {
  release: () => void
}

function createSessionScope(): number {
  return randomBytes(5).readUIntBE(0, 5)
}

let allocationSessionBase = 0
let allocationSessionCounter = 0
let sessionInitialized = false
let allocatedSessionScopeCount = 1
let generationRegistryEpoch = 0
let retainedGenerationLeases = 0
let retainedTargetIdBytes = 0
const connectionGenerationByTarget = new Map<string, SshConnectionGenerationEntry>()

function rotateAllocationSessionScope(): void {
  if (allocatedSessionScopeCount >= MAX_SESSION_SCOPE + 1) {
    throw new Error('SSH connection generation exhausted for this runtime session')
  }
  const nextSessionScope =
    (allocationSessionBase / SESSION_COUNTER_STRIDE + 1) % (MAX_SESSION_SCOPE + 1)
  allocationSessionBase = nextSessionScope * SESSION_COUNTER_STRIDE
  allocationSessionCounter = 0
  allocatedSessionScopeCount += 1
}

function allocateGeneration(): number {
  if (allocationSessionCounter >= SESSION_COUNTER_STRIDE - 1) {
    rotateAllocationSessionScope()
  }
  allocationSessionCounter += 1
  const generation = allocationSessionBase + allocationSessionCounter
  if (!Number.isSafeInteger(generation)) {
    throw new Error('SSH connection generation exhausted for this runtime session')
  }
  return generation
}

function measureTargetId(targetId: string): number {
  const measured = measureUtf8ByteLength(targetId, {
    stopAfterBytes: MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES
  })
  if (measured.exceededLimit) {
    throw new Error(
      `SSH connection generation target id exceeds ${MAX_SSH_CONNECTION_GENERATION_TARGET_ID_BYTES} UTF-8 bytes`
    )
  }
  return measured.byteLength
}

export function retainSshConnectionGeneration(targetId: string): SshConnectionGenerationLease {
  if (retainedGenerationLeases >= MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES) {
    throw new Error('SSH connection generation lease capacity exhausted')
  }
  let entry = connectionGenerationByTarget.get(targetId)
  if (!entry) {
    const targetIdBytes = measureTargetId(targetId)
    if (
      connectionGenerationByTarget.size >= MAX_TRACKED_SSH_CONNECTION_GENERATIONS ||
      retainedTargetIdBytes + targetIdBytes > MAX_SSH_CONNECTION_GENERATION_RETAINED_TARGET_ID_BYTES
    ) {
      throw new Error('SSH connection generation target capacity exhausted')
    }
    entry = {
      generation: allocateGeneration(),
      leaseCount: 0,
      targetIdBytes
    }
    connectionGenerationByTarget.set(targetId, entry)
    retainedTargetIdBytes += targetIdBytes
  }
  entry.leaseCount += 1
  retainedGenerationLeases += 1
  const retainedEntry = entry
  const retainedEpoch = generationRegistryEpoch
  let retained = true
  return {
    release: () => {
      if (!retained) {
        return
      }
      retained = false
      retainedEntry.leaseCount -= 1
      if (generationRegistryEpoch === retainedEpoch) {
        retainedGenerationLeases -= 1
      }
      if (
        retainedEntry.leaseCount === 0 &&
        connectionGenerationByTarget.get(targetId) === retainedEntry
      ) {
        connectionGenerationByTarget.delete(targetId)
        retainedTargetIdBytes -= retainedEntry.targetIdBytes
      }
    }
  }
}

export function getSshConnectionGeneration(targetId: string): number {
  return connectionGenerationByTarget.get(targetId)?.generation ?? allocationSessionBase
}

export function initializeSshConnectionGenerationSession(): void {
  if (sessionInitialized) {
    return
  }
  allocationSessionBase = createSessionScope() * SESSION_COUNTER_STRIDE
  allocationSessionCounter = 0
  allocatedSessionScopeCount = 1
  sessionInitialized = true
}

export function advanceSshConnectionGeneration(targetId: string): number | null {
  const entry = connectionGenerationByTarget.get(targetId)
  if (!entry) {
    return null
  }
  entry.generation = allocateGeneration()
  return entry.generation
}

export function setSshConnectionGeneration(targetId: string, generation: number): void {
  const generationOffset = generation - allocationSessionBase
  if (
    !Number.isSafeInteger(generation) ||
    generationOffset < 0 ||
    generationOffset >= SESSION_COUNTER_STRIDE
  ) {
    throw new Error('SSH connection generation exhausted for this runtime session')
  }
  let entry = connectionGenerationByTarget.get(targetId)
  if (!entry) {
    const targetIdBytes = measureTargetId(targetId)
    if (
      retainedGenerationLeases >= MAX_RETAINED_SSH_CONNECTION_GENERATION_LEASES ||
      connectionGenerationByTarget.size >= MAX_TRACKED_SSH_CONNECTION_GENERATIONS ||
      retainedTargetIdBytes + targetIdBytes > MAX_SSH_CONNECTION_GENERATION_RETAINED_TARGET_ID_BYTES
    ) {
      throw new Error('SSH connection generation target capacity exhausted')
    }
    entry = { generation, leaseCount: 1, targetIdBytes }
    connectionGenerationByTarget.set(targetId, entry)
    retainedGenerationLeases += 1
    retainedTargetIdBytes += targetIdBytes
  } else {
    entry.generation = generation
  }
  allocationSessionCounter = Math.max(allocationSessionCounter, generationOffset)
}

export function resetSshConnectionGenerations(sessionScope = 0): void {
  if (!Number.isSafeInteger(sessionScope) || sessionScope < 0 || sessionScope > MAX_SESSION_SCOPE) {
    throw new Error('Invalid SSH connection generation session scope')
  }
  allocationSessionBase = sessionScope * SESSION_COUNTER_STRIDE
  allocationSessionCounter = 0
  sessionInitialized = true
  allocatedSessionScopeCount = 1
  generationRegistryEpoch += 1
  retainedGenerationLeases = 0
  retainedTargetIdBytes = 0
  connectionGenerationByTarget.clear()
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
  const current = connectionGenerationByTarget.get(connectionId)
  if (
    expectedTargetId !== connectionId ||
    expectedGeneration === undefined ||
    !current ||
    expectedGeneration !== current.generation
  ) {
    throw new Error('SSH connection changed; refresh and try again')
  }
}

export const _internals = {
  evidenceForTest(): {
    retainedGenerationLeases: number
    retainedTargetIdBytes: number
    trackedTargets: number
  } {
    return {
      retainedGenerationLeases,
      retainedTargetIdBytes,
      trackedTargets: connectionGenerationByTarget.size
    }
  }
}
