import type { PublicKnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'

export function formatEnvironmentList(result: {
  environments: PublicKnownRuntimeEnvironment[]
}): string {
  if (result.environments.length === 0) {
    return 'No saved environments.'
  }
  return result.environments
    .map(
      (environment) =>
        `${environment.id}  ${environment.name}  ${environment.endpoints[0]?.endpoint ?? 'no-endpoint'}`
    )
    .join('\n')
}

export function formatEnvironment(environment: PublicKnownRuntimeEnvironment): string {
  return [
    `id: ${environment.id}`,
    `name: ${environment.name}`,
    `runtimeId: ${environment.runtimeId ?? 'unknown'}`,
    `lastUsedAt: ${environment.lastUsedAt ?? 'never'}`,
    `preferredEndpointId: ${environment.preferredEndpointId}`,
    ...environment.endpoints.map(
      (endpoint) => `endpoint: ${endpoint.id} ${endpoint.kind} ${endpoint.endpoint}`
    )
  ].join('\n')
}
