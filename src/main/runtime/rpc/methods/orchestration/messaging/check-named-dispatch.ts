/**
 * Serves the Dispatch mailbox the caller NAMED, under exactly the fences the implicit route uses.
 *
 * Explicit selection is not relaxed authority: naming a Dispatch id does not let a caller read a
 * Dispatch it does not hold, one that was superseded, or one whose worker process was replaced.
 */

import type { MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { checkWorkerMailbox } from './check-worker'
import {
  callerHoldsDispatchPane,
  dispatchFenced,
  isSupersededDispatch
} from './dispatch-mailbox-fence'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

export async function checkNamedDispatchMailbox(args: {
  params: z.infer<typeof CheckParams>
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  dispatchId: string
}): Promise<unknown> {
  const { db, handle, paneKey, dispatchId } = args
  const active = db.getActiveDispatchForIdentity(handle, paneKey)
  if (active?.id === dispatchId) {
    if (!callerHoldsDispatchPane(active, paneKey) || isSupersededDispatch(active)) {
      throw dispatchFenced()
    }
    return checkWorkerMailbox({
      params: args.params,
      runtime: args.runtime,
      db,
      handle,
      paneKey,
      typeFilter: args.typeFilter,
      signal: args.signal,
      activeDispatch: active,
      remoteAttachment: undefined
    })
  }
  // A federated worker host holds no dispatch_contexts row of its own; its Attempt lives on the
  // attachment. Named selection must reach it too, or a federated reuse loses the same mailbox.
  const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
  if (remoteAttachment?.dispatch_id === dispatchId) {
    if (
      !db.isRemoteAttachmentProcessCurrent({
        dispatchId,
        paneKey: paneKey ?? null,
        processIncarnation: args.runtime.getTerminalProcessIncarnation(handle)
      })
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is no longer attached to this worker process.`
      )
    }
    return checkWorkerMailbox({
      params: args.params,
      runtime: args.runtime,
      db,
      handle,
      paneKey,
      typeFilter: args.typeFilter,
      signal: args.signal,
      activeDispatch: undefined,
      remoteAttachment
    })
  }
  // Unknown ids are named as such; a real Dispatch this caller does not hold is fenced without
  // saying whose it is.
  if (!db.getDispatchContextById(dispatchId)) {
    throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
  }
  throw dispatchFenced()
}
