const generationByEnvironment = new Map<string, number>()

export function getRuntimeEnvironmentTransportGeneration(environmentId: string): number {
  return generationByEnvironment.get(environmentId) ?? 0
}

export function advanceRuntimeEnvironmentTransportGeneration(environmentId: string): void {
  generationByEnvironment.set(
    environmentId,
    getRuntimeEnvironmentTransportGeneration(environmentId) + 1
  )
}
