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

/** A group candidate; `mailbox` is set when the recipient is already a durable Dispatch address. */
type GroupCandidate = OrchestrationAddressableAgent & { mailbox?: { to: string; runId: string } }

/**
 * The Run whose Dispatches a group address means.
 *
 * A nested coordinator is BOTH a worker of its parent Run and the coordinator of the Run it
 * created, and `resolveMessageRun` answers with the parent — correctly, because that is where
 * its own `worker_done` belongs. Audience is the other question: it typed `@all` while acting
 * as a coordinator, so it means the workers it started, not the siblings it was started
 * beside. Resolving audience off the coordinated Run is why this does not just reuse
 * `routing.run`; a leaf worker coordinates nothing and falls through to its Dispatch's Run.
 */
function resolveGroupAudienceRunId(
  db: OrchestrationDb,
  senderPaneKey: string | undefined,
  senderRunId: string | undefined
): string | undefined {
  const coordinated = senderPaneKey ? db.getCurrentRunForPane(senderPaneKey) : undefined
  return coordinated?.id ?? senderRunId
}

/**
 * A Run's live Dispatches as group candidates, addressed as `dispatch:<id>`.
 *
 * Why the Run and not the host: `@all` used to resolve against every terminal on the machine,
 * so a coordinator meaning "my three reviewers" once reached 126 agents across every open
 * project. Nobody has an audience of "every terminal in every project"; the Run is the only
 * scope a sender can mean. Status and identity are read off the Dispatch's recorded terminal
 * handle, so `@idle` / `@codex` fail closed for a worker whose terminal is not attached yet.
 */
function listRunGroupCandidates(args: {
  db: OrchestrationDb
  senderRunId: string
  agents: readonly OrchestrationAddressableAgent[]
  warnings: SendRecipientWarning[]
}): GroupCandidate[] {
  const { db, senderRunId, agents, warnings } = args
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
    const handle = row.agentTerminalHandle ?? to
    const agentIdentity = identityByHandle.get(handle)
    return [
      {
        handle,
        worktreeId: row.worktreeId ?? '',
        ...(agentIdentity ? { agentIdentity } : {}),
        mailbox: { to, runId: row.runId }
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
  // `@worktree:<id>` names one workspace explicitly; every other group means the sender's Run.
  const worktreeGroup = groupAddress.toLowerCase().startsWith('@worktree:')
  const audienceRunId = resolveGroupAudienceRunId(db, senderPaneKey, senderRunId)
  if (!worktreeGroup && !audienceRunId) {
    throw new OrchestrationError(
      'invalid_argument',
      `${groupAddress} addresses the sender's Run, and ${from} is not bound to one. Send to run:<id> or dispatch:<id> instead.`
    )
  }
  // Why: fan out one message per recipient (independent read-tracking) but share a thread_id for correlation (Section 4.5).
  const { terminals } = await runtime.listTerminals(undefined, undefined, {
    includeVisualLayouts: false
  })
  // Immediately after the only await: a coordinator taken over during terminal discovery is
  // read-only, and must be told that whatever else is wrong with its recipient set. Everything
  // below is synchronous, so no takeover can interleave between here and the insert.
  revalidateLegacyCoordinator?.()
  // Structured workers are on no PTY surface, so `listTerminals` cannot see them and a broadcast
  // silently missed every one. Composed here rather than inside `listTerminals`, whose result is
  // published to paired clients and to consumers that assume a summary is writable.
  const agents = [...terminals, ...listAddressableStructuredWorkers()]
  const groupWarnings: SendRecipientWarning[] = []
  const candidates: GroupCandidate[] =
    worktreeGroup || !audienceRunId
      ? agents
      : listRunGroupCandidates({ db, senderRunId: audienceRunId, agents, warnings: groupWarnings })
  const handles = resolveGroupAddress(groupAddress, from, candidates, (handle: string) =>
    runtime.getAgentStatusForHandle(handle)
  )
  if (handles.length === 0) {
    // Why the warnings are appended: when every live Dispatch was skipped as federated, they
    // hold the only text naming the workers that DO exist and how to address each one.
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
