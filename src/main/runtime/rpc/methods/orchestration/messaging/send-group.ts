import type { MessagePriority, MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveGroupAddress } from '../../../../orchestration/groups'
import { resolveBareOrchestrationRecipient } from './recipient-routing'
import {
  listAddressableStructuredWorkers,
  type OrchestrationAddressableAgent
} from '../../../../orchestration/structured-worker-group-addressing'
import { legacyWorkerDeliveryContract } from '../routing'
import { exposeMessages } from './mailbox-message-receipt'
import { recordReceiptBeforeNudge } from './mutation-replay-nudge'
import type { BareRecipientResolution, SendRecipientWarning } from './recipient-routing'
import type { SendParams } from '../schemas'
import type { z } from 'zod'

type SendParamsInput = z.infer<typeof SendParams>
type SendReceipt = <T extends object>(receipt: T) => T & { warnings?: SendRecipientWarning[] }

/** Run candidates already identify a durable mailbox. */
type GroupCandidate = OrchestrationAddressableAgent & { mailbox?: { to: string; runId: string } }

function listRunGroupCandidates(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  senderRunId: string
  agents: readonly OrchestrationAddressableAgent[]
  warnings: SendRecipientWarning[]
}): GroupCandidate[] {
  const { db, runtime, senderRunId, agents, warnings } = args
  const live = db
    .listWorkerTerminalResources({ runId: senderRunId })
    .filter((row) => row.dispatchStatus === 'pending' || row.dispatchStatus === 'dispatched')
  // A federated worker reads relayed control mail, not this database's Dispatch mailbox.
  const federated = new Set(
    db.listFederatedDispatchesByIds(live.map((row) => row.dispatchId)).map((row) => row.dispatch_id)
  )
  const identityByHandle = new Map(agents.map((agent) => [agent.handle, agent.agentIdentity]))
  return live.flatMap((row) => {
    const to = `dispatch:${row.dispatchId}`
    if (federated.has(row.dispatchId)) {
      warnings.push({
        code: 'recipient_unreachable',
        recipient: to,
        message: `${to} runs on a remote Orca server; group fan-out does not relay there. Send --to ${to} instead.`
      })
      return []
    }
    const paneKey =
      row.paneKey ??
      (row.agentTerminalHandle ? runtime.getLiveTerminalPaneKey(row.agentTerminalHandle) : null)
    const handle =
      (paneKey ? runtime.getTerminalHandleForPaneKey(paneKey) : null) ??
      row.agentTerminalHandle ??
      to
    // Nested coordinators consume their child Run mailbox, not their parent Dispatch mailbox.
    const coordinated = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
    const agentIdentity = identityByHandle.get(handle)
    return [
      {
        handle,
        worktreeId: row.worktreeId ?? '',
        ...(agentIdentity ? { agentIdentity } : {}),
        mailbox: coordinated
          ? { to: `run:${coordinated.id}`, runId: coordinated.id }
          : { to, runId: row.runId }
      }
    ]
  })
}

export async function sendGroupMessage(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  groupAddress: string
  senderPaneKey: string | undefined
  senderRunId: string | undefined
  explicitRunId: string | undefined
  legacyCoordinatorRunId: string | undefined
  revalidateLegacyCoordinator: (() => string) | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  withSendWarnings: SendReceipt
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    from,
    groupAddress,
    senderPaneKey,
    senderRunId,
    explicitRunId,
    legacyCoordinatorRunId,
    revalidateLegacyCoordinator,
    recordMutationReceipt
  } = args
  // Audience follows the sender's binding, never a caller-supplied message Run or payload.
  function resolveAudienceRunId(): string {
    const coordinated = senderPaneKey ? db.getCurrentRunForPane(senderPaneKey) : undefined
    const runId =
      coordinated?.id ??
      db.getActiveDispatchForIdentity(from, senderPaneKey)?.run_id ??
      legacyCoordinatorRunId
    if (!runId) {
      throw new OrchestrationError(
        'invalid_argument',
        `${groupAddress} addresses the sender's Run, and ${from} is not bound to one. Send to run:<id> or dispatch:<id> instead.`
      )
    }
    if (explicitRunId && explicitRunId !== runId) {
      throw new OrchestrationError(
        'invalid_argument',
        `${groupAddress} addresses Run ${runId}, not explicitly requested Run ${explicitRunId}.`
      )
    }
    return runId
  }

  // `@worktree:<id>` names one workspace explicitly; every other group means the sender's Run.
  const worktreeGroup = groupAddress.toLowerCase().startsWith('@worktree:')
  let audienceRunId = worktreeGroup ? undefined : resolveAudienceRunId()
  let agents: OrchestrationAddressableAgent[] = []
  if (worktreeGroup || !['@all', '@idle'].includes(groupAddress.toLowerCase())) {
    const { terminals } = await runtime.listTerminals(undefined, undefined, {
      includeVisualLayouts: false
    })
    agents = [...terminals, ...listAddressableStructuredWorkers()]
  }
  // Revalidate after discovery before selecting recipients or writing mail.
  revalidateLegacyCoordinator?.()
  if (!worktreeGroup) {
    audienceRunId = resolveAudienceRunId()
  }
  const groupWarnings: SendRecipientWarning[] = []
  const candidates: GroupCandidate[] =
    worktreeGroup || !audienceRunId
      ? agents
      : listRunGroupCandidates({
          db,
          runtime,
          senderRunId: audienceRunId,
          agents,
          warnings: groupWarnings
        })
  const handles = resolveGroupAddress(groupAddress, from, candidates, (handle: string) =>
    runtime.getAgentStatusForHandle(handle)
  )
  if (handles.length === 0) {
    // Preserve the recovery addresses even when every worker was skipped.
    const skipped = groupWarnings.map((warning) => warning.message).join(' ')
    throw new OrchestrationError(
      'terminal_not_found',
      `No recipients resolved for group address: ${groupAddress}${skipped ? ` ${skipped}` : ''}`
    )
  }

  const legacyAdoptedMailboxOwner = db.getLegacyAdoptedRunMailboxOwner()
  const resolvedRecipients = handles.map((handle): BareRecipientResolution => {
    const mailbox = candidates.find((candidate) => candidate.handle === handle)?.mailbox
    return mailbox
      ? { ok: true, to: mailbox.to, runId: mailbox.runId }
      : resolveBareOrchestrationRecipient({
          runtime,
          db,
          handle,
          senderRunId,
          explicitRunId,
          legacyAdoptedMailboxOwner
        })
  })
  const deliverableRecipients = resolvedRecipients.filter(
    (recipient): recipient is BareRecipientResolution & { ok: true } => recipient.ok
  )
  const senderRecipient = resolveBareOrchestrationRecipient({
    runtime,
    db,
    handle: from,
    senderRunId,
    legacyAdoptedMailboxOwner
  })
  const senderMailboxKey = senderRecipient.ok
    ? `${senderRecipient.runId ?? ''}\u0000${senderRecipient.to}`
    : undefined
  const seenMailboxes = new Set<string>()
  const uniqueRecipients = deliverableRecipients.filter((resolution) => {
    const mailboxKey = `${resolution.runId ?? ''}\u0000${resolution.to}`
    if (mailboxKey === senderMailboxKey || seenMailboxes.has(mailboxKey)) {
      return false
    }
    seenMailboxes.add(mailboxKey)
    return true
  })
  if (uniqueRecipients.length === 0) {
    throw new OrchestrationError(
      'terminal_not_found',
      `No recipient of ${groupAddress} resolved to a live terminal or durable Run/Dispatch mailbox.`
    )
  }

  const threadId = params.threadId ?? `thread_${Date.now()}`
  const messages = db.insertMessages(
    uniqueRecipients.map((resolution) => ({
      from,
      to: resolution.to,
      subject: params.subject,
      body: params.body,
      type: params.type as MessageType,
      priority: params.priority as MessagePriority,
      threadId,
      payload: params.payload,
      senderPaneKey,
      runId: resolution.runId,
      deliveryContract: legacyWorkerDeliveryContract(
        runtime,
        resolution.runId ?? legacyCoordinatorRunId,
        resolution.to
      )
    }))
  )
  groupWarnings.push(
    ...resolvedRecipients.flatMap((resolution) =>
      resolution.ok ? (resolution.warning ? [resolution.warning] : []) : [resolution.warning]
    )
  )
  const receipt = {
    messages: exposeMessages(messages),
    recipients: messages.length,
    ...(groupWarnings.length > 0 ? { warnings: groupWarnings } : {})
  }
  return recordReceiptBeforeNudge(recordMutationReceipt, receipt, () => {
    for (const message of messages) {
      runtime.notifyMessageArrived(message.to_handle, message.type)
    }
  })
}
