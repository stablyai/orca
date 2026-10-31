import type { DispatchContextRow, TaskRow } from '../../../../orchestration/types'
import type { OrchestrationAdmission } from '../../../../orchestration/orchestration-admission'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  createPreviousCustodianLookup,
  type CustodyReaders
} from '../../../../orchestration/db/worker-terminal/worker-custody-read'
import type { WorkerFollowUp } from './worker-follow-up-placement'
export type HelperDispatch = Pick<
  DispatchContextRow,
  | 'id'
  | 'run_id'
  | 'creator_dispatch_id'
  | 'follow_up_of_dispatch_id'
  | 'process_incarnation'
  | 'host_scope'
>
export type HelperReaders<D extends HelperDispatch> = CustodyReaders & {
  dispatch: (id: string) => D | undefined
  taskDispatch: (id: string) => Pick<DispatchContextRow, 'creator_dispatch_id'> | undefined
}

/** Incremental reach and completed roots are scratch for one caller/Run invocation. */
export function createHelperStartScope<D extends HelperDispatch>(
  read: HelperReaders<D>,
  creator: D
) {
  const previous = createPreviousCustodianLookup(read)
  const roots = new Map<string, D | undefined>()
  const reached = new Set<string>()
  const expanded = new Set<string>()
  const pending: { row: D | undefined; expand: boolean }[] = [{ row: creator, expand: false }]
  const root = (id: string) => {
    const path: string[] = []
    const seen = new Set<string>()
    let result: D | undefined
    let row = read.dispatch(id)
    while (row && row.run_id === creator.run_id && !seen.has(row.id)) {
      if (roots.has(row.id)) {
        result = roots.get(row.id)
        break
      }
      path.push(row.id)
      if (!row.follow_up_of_dispatch_id) {
        result = row
        break
      }
      seen.add(row.id)
      row = read.dispatch(row.follow_up_of_dispatch_id)
    }
    for (const key of path) {
      roots.set(key, result)
    }
    return result
  }
  const continues = (owner: string) => {
    if (reached.has(owner)) {
      return true
    }
    while (pending.length) {
      const frame = pending.pop()!
      const row = frame.row
      if (!row || row.run_id !== creator.run_id || expanded.has(row.id)) {
        continue
      }
      if (!frame.expand) {
        if (reached.has(row.id)) {
          continue
        }
        reached.add(row.id)
        if (row.id === owner) {
          pending.push({ row, expand: true })
          return true
        }
      }
      const children: (D | undefined)[] = []
      for (const id of new Set([row.follow_up_of_dispatch_id, previous(row)])) {
        if (id && !reached.has(id)) {
          children.push(read.dispatch(id))
        }
      }
      expanded.add(row.id)
      for (const child of children) {
        pending.push({ row: child, expand: false })
      }
    }
    return false
  }
  return (args: {
    task: Pick<TaskRow, 'id'> | undefined
    params: { on?: string; terminal?: string }
    followUp?: Pick<WorkerFollowUp, 'of' | 'addressed' | 'custodian'>
  }): OrchestrationAdmission<void> => {
    if (args.params.on || args.params.terminal) {
      // Remote reports reach the Run home mailbox, so a helper there could not report to its creator.
      return {
        kind: 'refused',
        error: new OrchestrationError(
          'invalid_argument',
          'A worker starts helpers in a new agent on this host; omit --on and --terminal. No effects were applied.',
          { effectsApplied: false }
        )
      }
    }
    if (args.task && read.taskDispatch(args.task.id)?.creator_dispatch_id !== creator.id) {
      return {
        kind: 'refused',
        error: new OrchestrationError(
          'task_not_found',
          `Task ${args.task.id} was not last run by a helper of Dispatch ${creator.id}; start new helper work with --spec.`
        )
      }
    }
    if (args.followUp) {
      const { of, addressed, custodian } = args.followUp
      const holder = custodian ? read.dispatch(custodian) : root(of)
      const owner = holder?.run_id === creator.run_id ? holder.creator_dispatch_id : null
      if (!owner || !continues(owner)) {
        const target =
          of === addressed
            ? `Dispatch ${addressed}`
            : `Dispatch ${addressed}'s latest work, Dispatch ${of},`
        return {
          kind: 'refused',
          error: new OrchestrationError(
            'task_not_found',
            `${target} is not a helper of Dispatch ${creator.id}, so only the coordinator or the worker that started it can give it more work; to hand this to a helper, start new helper work with worker-start --spec. No effects were applied.`,
            { effectsApplied: false }
          )
        }
      }
    }
    return { kind: 'admitted', value: undefined }
  }
}
