import { parseExecutionHostId } from '../../shared/execution-host'
import {
  isProviderResourceDiagnosticOperation,
  unavailableProviderResourceDiagnostic,
  type ProviderResourceDiagnosticHook,
  type ProviderResourceDiagnosticQuery,
  type ProviderResourceDiagnosticResult
} from '../../shared/provider-resource-diagnostics'
import { getProvider } from '../ipc/pty/provider/registry'

let pending = 0
const MAX_REQUESTS = 8

export function forwardLocalProviderResourceHook(hook: ProviderResourceDiagnosticHook): void {
  if (process.env.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS !== '1' || pending >= MAX_REQUESTS) {
    return
  }
  const operation = { kind: 'hook' as const, hook }
  if (!isProviderResourceDiagnosticOperation(operation)) {
    return
  }
  pending++
  void Promise.resolve()
    .then(() => getProvider(null).providerResourceDiagnostic?.(operation))
    .catch(() => {})
    .finally(() => {
      pending--
    })
}

export async function routeProviderResourceDiagnostic(args: {
  executionHostId?: string
  query: ProviderResourceDiagnosticQuery
}): Promise<ProviderResourceDiagnosticResult | null> {
  if (process.env.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS !== '1') {
    return null
  }
  if (!args || !isProviderResourceDiagnosticOperation({ kind: 'query', query: args.query })) {
    return null
  }
  const unavailable = (reason: ProviderResourceDiagnosticResult['reason']) =>
    unavailableProviderResourceDiagnostic(args.query.requestId, reason)
  if (pending >= MAX_REQUESTS) {
    return unavailable('probe-capacity')
  }
  const host =
    typeof args.executionHostId === 'string' ? parseExecutionHostId(args.executionHostId) : null
  if (!host || host.kind === 'runtime') {
    return unavailable('unsupported')
  }
  pending++
  try {
    const provider = getProvider(host.kind === 'ssh' ? host.targetId : null)
    return (
      (await provider.providerResourceDiagnostic?.({ kind: 'query', query: args.query })) ??
      unavailable('unsupported')
    )
  } catch {
    return unavailable('unreachable')
  } finally {
    pending--
  }
}

export function recordProviderResourceDiagnosticOutcome(
  requestId: string | undefined,
  outcome: 'attached' | 'spawned' | 'failed'
): void {
  if (
    process.env.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS !== '1' ||
    !requestId ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)
  ) {
    return
  }
  try {
    console.info('[provider-resource-diagnostic]', { requestId, outcome })
  } catch {
    /* Observational only. */
  }
}
