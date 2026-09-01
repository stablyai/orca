// Routes a reconciling pending launch to its owner record's persistence slice by
// INTENT (U6). Each unattended launch kind lands its reconciled outcome in a
// different owner store — background attempt, automation run, orchestration
// dispatch, or the interactive worktree meta — so a background attempt's failure
// never overwrites a worktree's launch card even if their scope ids collide. The
// arms are injected so this stays electron-free and unit-testable; the runtime
// binds each arm to its concrete store write.

import type { PendingAgentLaunchSnapshot } from './agent-launch-operation-store'
import type { ReconcileScopePersistence } from './agent-launch-worktree-reconcile-writer'

/** Owner-record persistence factories, one per launch-intent family. Each takes
 *  the pending's scope id (the owner bucket: worktree id, run id, dispatch id, or
 *  attempt id) and returns the tri-state writer the reconciler drives. */
export type ReconcileIntentRouterArms = {
  /** interactive / cli / resume launches — scope is a worktree id. */
  worktree: (worktreeId: string) => ReconcileScopePersistence
  /** automation launches — scope is an automation run id. */
  automation: (runId: string) => ReconcileScopePersistence
  /** orchestration launches — scope is a dispatch context id. */
  orchestration: (dispatchId: string) => ReconcileScopePersistence
  /** background launches — scope is a background attempt id. */
  background: (attemptId: string) => ReconcileScopePersistence
}

/** Pick the owner-record persistence slice for one pending launch by its intent.
 *  interactive/cli/resume all resolve to the worktree writer (they share the
 *  WorktreeMeta launch card); the three unattended kinds each get their own. */
export function reconcilePersistenceForIntent(
  arms: ReconcileIntentRouterArms,
  pending: PendingAgentLaunchSnapshot
): ReconcileScopePersistence {
  switch (pending.intent) {
    case 'interactive':
    case 'cli':
    case 'resume':
      return arms.worktree(pending.scope)
    case 'automation':
      return arms.automation(pending.scope)
    case 'orchestration':
      return arms.orchestration(pending.scope)
    case 'background':
      return arms.background(pending.scope)
  }
}
