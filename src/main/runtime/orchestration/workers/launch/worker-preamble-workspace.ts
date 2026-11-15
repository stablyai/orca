import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { PreambleParams } from './worker-dispatch-preamble'

export async function workerPreambleWorkspace(
  runtime: Pick<OrcaRuntimeService, 'showManagedTerminalWorkspace'> &
    Partial<Pick<OrcaRuntimeService, 'getOrchestrationWorkspaceSelectorArgument'>>,
  id?: string | null,
  handle = ''
): Promise<PreambleParams['workspace']> {
  if (!id) {
    return undefined
  }
  try {
    const row = await runtime.showManagedTerminalWorkspace(`id:${id}`)
    return {
      id: row.id,
      name: row.displayName || row.branch,
      path: row.path,
      parentArgument: runtime.getOrchestrationWorkspaceSelectorArgument?.(handle, row.id)
    }
  } catch {
    return undefined
  }
}
