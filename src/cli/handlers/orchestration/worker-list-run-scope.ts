import { getOptionalStringFlag } from '../../flags'
import type { RuntimeClient } from '../../runtime-client'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

export type WorkerListRunScope = { run?: string; source: 'flag' | 'bound' | 'all' }

// Default to the caller's bound Run; an explicit --run overrides it and unbound callers see all Runs.
export async function resolveWorkerListRunScope(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<WorkerListRunScope> {
  const explicit = getOptionalStringFlag(flags, 'run')
  if (explicit) {
    return { run: explicit, source: 'flag' }
  }
  try {
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
    const current = await client.call<{ run: { id: string } | null }>('orchestration.runCurrent', {
      from: terminal
    })
    return current.result.run ? { run: current.result.run.id, source: 'bound' } : { source: 'all' }
  } catch {
    // A missing caller binding or older runtime must not prevent a full inventory.
    return { source: 'all' }
  }
}

export function formatWorkerListScope(scope: WorkerListRunScope): string {
  if (scope.source === 'all') {
    return 'Scope: all Runs (no Run is bound to this terminal; pass --run to narrow)'
  }
  return `Scope: Run ${scope.run} (${scope.source === 'bound' ? 'bound to this terminal' : '--run'})`
}
