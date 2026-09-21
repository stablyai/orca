import type { OrcaRuntimeService } from '../orca-runtime'

export function routeDispatcherClientHostedBrowserRpc(
  runtime: OrcaRuntimeService,
  method: string,
  params: unknown
) {
  const candidate = runtime as OrcaRuntimeService & {
    routeClientHostedBrowserRpc?: OrcaRuntimeService['routeClientHostedBrowserRpc']
  }
  return candidate.routeClientHostedBrowserRpc?.(method, params) ?? { handled: false as const }
}
