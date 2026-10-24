import type { WorkspaceLifecycleKind } from '../../../shared/sidebar-list/workspace-lifecycle-hints'

export const WORKSPACE_DELETED_ERROR = 'workspace_deleted'

/** `unverifiable`: the execution host never confirmed the outcome, so the queue pauses. */
export type LifecycleOutcome = 'settled' | 'unverifiable'

/** Delete options: an equal delete joins the pending one, a different one is refused. */
export type LifecycleDeleteOptions = {
  key: string
  /** The explicit waiver (Force Delete, `--force`): runs past a pause, as it always has. */
  force: boolean
  /** Names the workspace in the "already in progress" refusal. */
  label: string
}

export type LifecycleCommand<T> = {
  kind: Exclude<WorkspaceLifecycleKind, 'create'>
  run: () => Promise<T>
  /** Reads a reply; defaults to settled. */
  outcome?: (result: T) => LifecycleOutcome
  /** Whether a thrown error means contact was lost mid-run rather than a definite failure. */
  lostContact?: (error: unknown) => boolean
  /** After an unconfirmed outcome: re-reads the owner's state, throwing while it cannot answer. */
  observe?: () => Promise<void>
  delete?: LifecycleDeleteOptions
}

/** Calls `done` once a listing that started after this call has applied. */
export type LifecycleMembership = (done: () => void) => void

export type LifecycleAttempt = {
  outcome: LifecycleOutcome
  value?: unknown
  error?: unknown
  threw: boolean
}

export async function attemptLifecycleCommand(
  command: LifecycleCommand<unknown>
): Promise<LifecycleAttempt> {
  try {
    const value = await command.run()
    return { outcome: command.outcome?.(value) ?? 'settled', value, threw: false }
  } catch (error) {
    return {
      outcome: command.lostContact?.(error) ? 'unverifiable' : 'settled',
      error,
      threw: true
    }
  }
}
