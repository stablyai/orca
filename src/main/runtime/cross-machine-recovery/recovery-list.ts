import type {
  RecoveryListResult,
  RecoveryListedBinding
} from '../../../shared/cross-machine-recovery-descriptor'
import type { CrossMachineRecoveryRuntime } from './recovery-export'

/** Dormant bindings a cross-machine import left on this host, awaiting an explicit resume. */
export async function listRecoveryBindings(
  runtime: CrossMachineRecoveryRuntime,
  worktreeSelector: string | undefined
): Promise<RecoveryListResult> {
  const worktreeId =
    worktreeSelector === undefined
      ? undefined
      : (await runtime.showManagedWorktree(worktreeSelector)).id
  const { store } = runtime.readCrossMachineRecoveryHostState()
  const records = Object.values(
    store.getWorkspaceSession('local').sleepingAgentSessionsByPaneKey ?? {}
  )
  const bindings = records.flatMap((record): RecoveryListedBinding[] => {
    if (
      record.origin !== 'recovery' ||
      !record.recovery ||
      (worktreeId !== undefined && record.worktreeId !== worktreeId)
    ) {
      return []
    }
    return [
      {
        worktreeId: record.worktreeId,
        localPaneKey: record.paneKey,
        importKey: record.recovery.importKey,
        sourcePaneKey: record.recovery.sourcePaneKey,
        agent: record.agent,
        providerSession: record.providerSession,
        ...(record.terminalTitle ? { terminalTitle: record.terminalTitle } : {}),
        capturedAt: record.capturedAt,
        updatedAt: record.updatedAt,
        provenance: store.getWorktreeMeta(record.worktreeId)?.recoveryProvenance ?? null
      }
    ]
  })
  return { bindings }
}
