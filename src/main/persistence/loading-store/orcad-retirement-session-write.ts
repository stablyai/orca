import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import { reconcileOrcadRetirementSessionReplay } from '../migrating-orcad-catalog/orcad-retirement-session-replay'
import { hasOrcadRetirementPublicationAuthority } from '../migrating-orcad-catalog/orcad-retirement-publication-proof'
import { collectTerminalScrollbackSnapshotRefs } from '../../terminal-scrollback-snapshots'

type PublicationRuntime = Pick<StoreRuntimeState, 'state' | 'orcadRetirementSessionPublication'>

/** Rollback records still own their snapshot files after source rows leave the profile. */
export function collectOrcadRetirementSnapshotRefs(
  runtime: PublicationRuntime
): ReadonlySet<string> {
  const refs = new Set<string>()
  for (const record of runtime.orcadRetirementSessionPublication.installedRecords(runtime.state)) {
    for (const change of record.changes) {
      if (change.field !== 'workspaceSession' && change.field !== 'workspaceSessionsByHostId') {
        continue
      }
      for (const saved of [change.before, change.after]) {
        if (saved === null) {
          continue
        }
        const decoded = JSON.parse(saved)
        const sessions: WorkspaceSessionState[] =
          change.field === 'workspaceSession' ? [decoded] : Object.values(decoded)
        for (const session of sessions) {
          if (!session) {
            continue
          }
          for (const ref of collectTerminalScrollbackSnapshotRefs(session)) {
            refs.add(ref)
          }
        }
      }
    }
  }
  return refs
}

/** Run before binding normalization or snapshot-file work can mutate the profile. */
export function reconcileOrcadRetirementSessionWrite(
  runtime: PublicationRuntime,
  session: WorkspaceSessionState,
  hostId: string
): WorkspaceSessionState {
  const records = runtime.orcadRetirementSessionPublication.installedRecords(runtime.state)
  let next = session
  for (const record of records) {
    next = reconcileOrcadRetirementSessionReplay(next, hostId, record)
  }
  if (!records.length) {
    return next
  }
  const candidate = {
    ...runtime.state,
    ...(hostId === 'local'
      ? { workspaceSession: next }
      : {
          workspaceSessionsByHostId: { ...runtime.state.workspaceSessionsByHostId, [hostId]: next }
        })
  }
  for (const record of records) {
    if (!hasOrcadRetirementPublicationAuthority(candidate, record)) {
      throw new Error('orcad_retirement_session_publication_conflict')
    }
  }
  return next
}
