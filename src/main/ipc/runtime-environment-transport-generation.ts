type TransportScope = 'control' | 'resource'
const generationByEnvironment = new Map<string, Record<TransportScope, number>>()

export function getRuntimeEnvironmentTransportGeneration(
  environmentId: string,
  scope: TransportScope = 'control'
): number {
  return generationByEnvironment.get(environmentId)?.[scope] ?? 0
}

export function advanceRuntimeEnvironmentTransportGeneration(
  environmentId: string,
  scope: TransportScope = 'control'
): void {
  const generations = generationByEnvironment.get(environmentId) ?? { control: 0, resource: 0 }
  generations[scope] += 1
  generationByEnvironment.set(environmentId, generations)
}
