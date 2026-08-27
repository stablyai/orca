import { statSync } from 'node:fs'
import type { OrchestrationDb } from '../db'
import { fingerprintGateDependencies } from './gate-dependency-fingerprint'
import type { GateShaBinding } from './gate-receipt-validity'

/** The worktree path a Dispatch's worker ran in, or null when the runtime has
 *  none it can read. Worktree ids are `<repoId>::<absolutePath>`. */
function readableWorktreePath(db: OrchestrationDb, dispatchId: string): string | null {
  const worktreeId = db.getWorkerDispatch(dispatchId)?.worktree_id
  const separator = worktreeId?.indexOf('::') ?? -1
  if (!worktreeId || separator === -1) {
    return null
  }
  const path = worktreeId.slice(separator + 2)
  try {
    return statSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

/** The completion receipt's fingerprint, and how it may be reused.
 *
 *  Why the split: the runtime genuinely cannot read a REMOTE worker's tree, and
 *  a path-only fingerprint proves nothing about content — reusing one across a
 *  commit would treat "same files touched" as "same bytes tested". So a tree we
 *  can read is fingerprinted by bytes and its receipt survives an unrelated
 *  commit; a tree we cannot read is bound to its exact head and never reused.
 */
export function completionGateInputs(
  db: OrchestrationDb,
  dispatchId: string,
  files: readonly string[],
  policyVersion: string,
  commandIdentity: string
): { inputHashes: Record<string, string>; shaBinding: GateShaBinding } {
  const cwd = readableWorktreePath(db, dispatchId)
  if (!cwd) {
    return {
      inputHashes: {
        'config:policyVersion': policyVersion,
        'config:commandIdentity': commandIdentity,
        'files:unreadable': files.join(',')
      },
      shaBinding: 'exact_head'
    }
  }
  return {
    inputHashes: fingerprintGateDependencies({
      spec: { gateId: commandIdentity, files },
      fallbackFiles: files,
      cwd,
      policyVersion,
      commandIdentity
    }),
    shaBinding: 'content'
  }
}
