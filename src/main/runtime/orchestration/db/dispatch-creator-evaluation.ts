import type { DispatchCreator } from './dispatch-depth'
import type { DispatchContextRow, RemoteDispatchAttachmentRow } from '../types'
import type { OrchestrationAdmission } from '../orchestration-admission'
import { isEquivalentPaneKey } from './pane-key-match'
import {
  NESTED_WORKER_DEPTH_EXCEEDED_CODE,
  NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS,
  ROOT_DISPATCH_DEPTH,
  nestedWorkerDepthExceededMessage
} from '../../../../shared/nested-worker-depth'
import { OrchestrationError } from '../orchestration-error'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from './federation/remote-attachment-liveness'

/** Self-dispatch is bookkeeping; pre-v37 rows lack creator identity and conservatively count as parents. */
export function isSelfCreatedDispatch(
  row: Pick<
    DispatchContextRow,
    'creator_pane_key' | 'assignee_pane_key' | 'creator_handle' | 'assignee_handle'
  >
): boolean {
  if (row.creator_pane_key && row.assignee_pane_key) {
    return isEquivalentPaneKey(row.creator_pane_key, row.assignee_pane_key)
  }
  return row.creator_handle != null && row.creator_handle === row.assignee_handle
}

/** Unknown start/stop outcomes cannot prove exit; count them as parents (docs/reference/ssh-execution-boundary.md). */
export class AmbiguousDispatchParentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousDispatchParentError'
  }
}

export type CreatorRole = Pick<
  DispatchContextRow,
  'id' | 'depth' | 'creator_pane_key' | 'assignee_pane_key' | 'creator_handle' | 'assignee_handle'
>
export type RemoteCreatorRole = Pick<
  RemoteDispatchAttachmentRow,
  'dispatch_id' | 'depth' | 'pane_key' | 'process_incarnation' | 'state'
>

/** Completed caller derivations live for one command or one snapshot action pass. */
export function createDispatchCreatorEvaluation(
  creator: DispatchCreator,
  readers: { local: () => CreatorRole | undefined; remote: () => RemoteCreatorRole[] }
) {
  let local: CreatorRole | null | undefined
  let remote: OrchestrationAdmission<RemoteCreatorRole[]> | undefined
  const roles = () => {
    if (local === undefined) {
      local = creator.kind === 'system' ? null : (readers.local() ?? null)
    }
    if (!remote) {
      const matches =
        creator.kind === 'terminal' && creator.paneKey && creator.processIncarnation
          ? readers
              .remote()
              .filter(
                (row) =>
                  row.process_incarnation === creator.processIncarnation &&
                  row.pane_key !== null &&
                  isEquivalentPaneKey(row.pane_key, creator.paneKey!) &&
                  POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.some((state) => state === row.state)
              )
          : []
      remote =
        matches.length > 1 && creator.kind === 'terminal'
          ? {
              kind: 'refused',
              error: new AmbiguousDispatchParentError(
                `Terminal ${creator.handle} matches ${matches.length} live remote attachments; cannot establish nesting depth.`
              )
            }
          : { kind: 'admitted', value: matches }
    }
    return remote
  }
  return {
    creatorId(): OrchestrationAdmission<string | null> {
      const result = roles()
      if (result.kind === 'refused') {
        return result
      }
      const own = local && !isSelfCreatedDispatch(local) ? local : undefined
      return {
        kind: 'admitted',
        value:
          (own ? 1 : 0) + result.value.length === 1
            ? (own?.id ?? result.value[0]?.dispatch_id ?? null)
            : null
      }
    },
    childDepth(maxDepth: number): OrchestrationAdmission<number> {
      const result = roles()
      if (result.kind === 'refused') {
        return result
      }
      const depths = result.value.map((row) => row.depth)
      if (local && !isSelfCreatedDispatch(local)) {
        depths.push(local.depth)
      }
      const depth = (depths.length ? Math.max(...depths) : ROOT_DISPATCH_DEPTH) + 1
      return depth > maxDepth
        ? {
            kind: 'refused',
            error: new OrchestrationError(
              NESTED_WORKER_DEPTH_EXCEEDED_CODE,
              nestedWorkerDepthExceededMessage(depth, maxDepth),
              { effectsApplied: false, nextSteps: [...NESTED_WORKER_DEPTH_EXCEEDED_NEXT_STEPS] }
            )
          }
        : { kind: 'admitted', value: depth }
    }
  }
}
