type RuntimeEnvironmentTransportGenerationEntry = {
  token: number
  leaseCount: number
}

export type RuntimeEnvironmentTransportGenerationLease = {
  isCurrent: () => boolean
  release: () => void
}

const generationByEnvironment = new Map<string, RuntimeEnvironmentTransportGenerationEntry>()
let nextGenerationToken = 1

function allocateGenerationToken(): number {
  if (!Number.isSafeInteger(nextGenerationToken)) {
    throw new Error('Runtime environment transport generation exhausted')
  }
  const token = nextGenerationToken
  nextGenerationToken += 1
  return token
}

export function retainRuntimeEnvironmentTransportGeneration(
  environmentId: string
): RuntimeEnvironmentTransportGenerationLease {
  let entry = generationByEnvironment.get(environmentId)
  if (!entry) {
    entry = { token: allocateGenerationToken(), leaseCount: 0 }
    generationByEnvironment.set(environmentId, entry)
  }
  entry.leaseCount += 1
  const retainedEntry = entry
  const retainedToken = entry.token
  let retained = true
  return {
    isCurrent: () =>
      retained &&
      generationByEnvironment.get(environmentId) === retainedEntry &&
      retainedEntry.token === retainedToken,
    release: () => {
      if (!retained) {
        return
      }
      retained = false
      retainedEntry.leaseCount -= 1
      if (
        retainedEntry.leaseCount === 0 &&
        generationByEnvironment.get(environmentId) === retainedEntry
      ) {
        generationByEnvironment.delete(environmentId)
      }
    }
  }
}

export function advanceRuntimeEnvironmentTransportGeneration(environmentId: string): void {
  const entry = generationByEnvironment.get(environmentId)
  if (entry) {
    entry.token = allocateGenerationToken()
  }
}

export const _internals = {
  trackedEnvironmentCountForTest(): number {
    return generationByEnvironment.size
  },
  resetForTest(): void {
    generationByEnvironment.clear()
    nextGenerationToken = 1
  }
}
