import type { MessageType } from '../../../../orchestration/db/orchestration-records'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { CheckMailReconciliation } from './check-mail-reconciliation'
import type { CheckParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>
type ActiveDispatch = NonNullable<ReturnType<OrchestrationDb['getActiveDispatchForIdentity']>>
type RemoteAttachment = NonNullable<
  ReturnType<OrchestrationDb['findActiveRemoteAttachmentForPane']>
>

export type WorkerMailboxCheckInput = {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  paneKey: string | undefined
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
  reconciliation: CheckMailReconciliation
  revalidateCaller?: () => void
  activeDispatch: ActiveDispatch | undefined
  remoteAttachment: RemoteAttachment | undefined
  wakeTypes?: MessageType[]
  revalidateConsumer?: () => void
  deferDelivery?: () => boolean
  recordMutationReceipt?: (receipt: unknown) => void
  /** An ack the enclosing Run check already applied, reported when this check applied none. */
  runAcknowledged?: string
  /** The caller's --ack came without --wait, so this check takes no new mail. */
  acknowledgeOnly?: boolean
}
