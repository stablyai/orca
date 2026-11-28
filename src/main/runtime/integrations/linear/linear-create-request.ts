import { codexNonMessageIdentity } from '../../../codex/structured/items/codex-thread-item-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { CONNECTOR_REPLY_METHOD } from '../../rpc/methods/connectors/connector'
import { chatPaneKey } from '../../../external-conversations/external-conversation-chat'
import { createHash } from 'node:crypto'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { requireStructuredHost } from '../../../bots/bot-chat-session'
import { linearAssignmentMatches } from '../../../webhooks/linear-issue-origin'
import { isLinearUuid } from '../../../../shared/linear/uuid'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../../rpc/core'
import type { LinearCreateAuthority } from './linear-create-origin'

function clarificationId(root: string, destination: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['linear-origin-question-v1', root, destination]))
    .digest()
  bytes[6] = (bytes[6] & 15) | 80
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.subarray(0, 16).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

// An omitted guard is reserved for the desktop UI and in-process operations.
export async function bindLinearCreateRequest(
  ctx: RpcContext
): Promise<LinearCreateAuthority | null | undefined> {
  if (ctx.caller?.kind === 'desktop' && !ctx.plugin && !ctx.orchestrationCaller) {
    return undefined
  }
  return (await readLinearCreateRequest(ctx)) ?? null
}

async function readLinearCreateRequest(
  ctx: RpcContext
): Promise<LinearCreateAuthority | undefined> {
  const { runtime, linearRequestRef } = ctx
  const session = sessionCallerOf(ctx.orchestrationCaller)?.sessionId
  if (!session || ctx.pairedDeviceId || ctx.plugin || ctx.caller?.kind !== 'local-cli') {
    return
  }
  const host = await requireStructuredHost(runtime)
  const journal = await host.journalReads(session)
  async function active() {
    const mark = await journal.runningRequest()
    if (!mark || mark.kind !== 'turn' || mark.turnState !== 'running' || mark.personStopped) {
      return
    }
    const turn = await journal.turnAttribution(mark.id, Number.MAX_SAFE_INTEGER)
    if (
      !turn.turnItemId ||
      !turn.opener ||
      turn.messages?.length !== 1 ||
      turn.messages[0].itemId !== turn.opener.itemId ||
      turn.opener.body.kind !== 'message' ||
      turn.opener.body.role !== 'user'
    ) {
      return
    }
    return {
      openerId: turn.opener.itemId,
      turnId: turn.turnItemId,
      key: JSON.stringify([
        session,
        turn.cursor.epoch,
        mark.fence,
        turn.turnItemId,
        turn.opener.itemId
      ]),
      opener: turn.opener.body
    }
  }
  const pinned = await active()
  const referenced = linearRequestRef
  // For a direct shell command the provider can name the native tool call. Re-read its
  // journal row; a completed shell or a call in an earlier turn cannot authorize a write.
  async function toolOwnsTurn(): Promise<boolean> {
    if (!pinned || !referenced || referenced.length > 512 || !referenced.startsWith('[')) {
      return false
    }
    try {
      const pair: unknown = JSON.parse(referenced)
      if (!Array.isArray(pair) || pair.length !== 2) {
        return false
      }
      const [thread, call] = pair
      if (
        typeof thread !== 'string' ||
        !isLinearUuid(thread) ||
        typeof call !== 'string' ||
        !call
      ) {
        return false
      }
      const key = agentJournalItemKey(codexNonMessageIdentity(thread, null, call))
      const item = await journal.itemDetail(key)
      return (
        item?.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === pinned.turnId &&
        item.body.kind === 'tool-call' &&
        item.body.callId === call &&
        item.body.codexCommandExecution === true &&
        item.body.state === 'running'
      )
    } catch {
      return false
    }
  }
  const byTool = referenced?.startsWith('[') === true
  if (!referenced || !(byTool ? await toolOwnsTurn() : isLinearUuid(referenced))) {
    return
  }
  const message = pinned?.opener
  const delivery = message?.origin === 'connector' ? message.connectorDelivery : undefined
  if (delivery && pinned && byTool && !delivery.carried?.length) {
    const { source, externalId } = delivery.conversation
    const requestId = delivery.deliveryId
    const replyTo = JSON.stringify([source, externalId])
    return {
      requestId,
      replyTo,
      readCurrent: async () => null,
      async askOriginOnce(text) {
        if (!(await sameTurn())) {
          throw new Error('Original turn changed')
        }
        const target = runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(session))
        if (
          !target?.turnId ||
          target.answerDeliveryId !== requestId ||
          target.key.source !== source ||
          target.key.externalId !== externalId
        ) {
          throw new Error('Original thread changed')
        }
        const sent = await CONNECTOR_REPLY_METHOD.handler(
          { sessionId: session, replyId: clarificationId(requestId, replyTo), text },
          ctx
        )
        if (sent.status !== 'posted') {
          throw new Error('Confirmation has not been posted')
        }
        return { requestId, destination: replyTo, messageId: sent.messageId }
      }
    }
  }
  const run = message?.origin === 'automation-run' ? message.automationRun : undefined
  const intake = run?.linearIssueIntake
  if (
    !run ||
    run.trigger !== 'event' ||
    !run.event?.webhook ||
    run.event.webhook.sample ||
    !intake?.sourceIssueKey ||
    !isLinearUuid(intake.sourceIssueId)
  ) {
    return
  }
  if (!byTool && referenced !== run.runId) {
    return
  }
  const { sourceIssueId, sourceIssueKey, sourceWorkspaceId } = intake
  const requestId = run.runId
  const replyTo = `linear/${sourceWorkspaceId}/${sourceIssueId}`
  async function verifyIssue() {
    const source = await runtime.linearIssueContext({
      input: sourceIssueKey,
      workspaceId: sourceWorkspaceId,
      include: {
        comments: false,
        children: false,
        attachments: false,
        relations: false,
        activity: false
      },
      depth: 0
    })
    if (
      source.issue.id !== sourceIssueId ||
      source.meta.resolved.id !== sourceIssueId ||
      source.meta.resolved.workspaceId !== sourceWorkspaceId
    ) {
      throw new Error('Original issue changed')
    }
    return source.issue
  }
  async function sameTurn() {
    return !!pinned && (await active())?.key === pinned.key && (!byTool || (await toolOwnsTurn()))
  }
  // Re-read the configured seat as well as the active call after waiting for the write slot.
  const assignedBot = () => {
    const bot = botOfSession(runtime.bots, session, host)
    if (
      !bot ||
      bot.id !== intake.receivingBotId ||
      bot.id !== run.automation.bot?.botId ||
      bot.id !== intake.configuredBotId ||
      !intake.assignedProjectId
    ) {
      return null
    }
    const matches = runtime
      .listAutomationsForScope()
      .automations.filter((a) => a.id === run.automation.id && a.enabled && a.bot?.botId === bot.id)
    const webhook = run.event?.webhook
    if (
      !webhook ||
      matches.length !== 1 ||
      !linearAssignmentMatches(intake, matches[0], webhook.hookId, bot.id)
    ) {
      return null
    }
    return bot
  }
  return {
    requestId,
    replyTo,
    stillCurrent: async () => (await sameTurn()) && assignedBot() !== null,
    async readCurrent() {
      if (!byTool && referenced !== run.runId) {
        return null
      }
      const source = await verifyIssue()
      const bot = assignedBot()
      const assigned = intake.assignedProjectId
      if (
        !assigned ||
        !bot ||
        source.project?.id !== intake.sourceProjectId ||
        !(await sameTurn())
      ) {
        return null
      }
      return {
        requestId,
        receivingBotId: bot.id,
        original: intake.sourceProjectId
          ? { workspaceId: sourceWorkspaceId, projectId: intake.sourceProjectId }
          : null,
        assignment: {
          botId: bot.id,
          project: { workspaceId: sourceWorkspaceId, projectId: assigned }
        }
      }
    },
    async askOriginOnce(message) {
      if (!(await sameTurn())) {
        throw new Error('Original request is no longer active')
      }
      await verifyIssue()
      // The return address is the already pinned original Issue, even if the seat has since changed.
      const writeId = clarificationId(requestId, replyTo)
      const receipt = await runtime.linearIssueAddComment(
        {
          input: sourceIssueKey,
          workspaceId: sourceWorkspaceId,
          writeId,
          body: `[Orca PM] ${message}`
        },
        ctx.signal,
        sourceIssueId
      )
      if (
        receipt.issue.id !== sourceIssueId ||
        receipt.meta.workspaceId !== sourceWorkspaceId ||
        receipt.comment.id !== writeId
      ) {
        throw new Error('Original issue did not acknowledge question')
      }
      return { requestId, destination: replyTo, messageId: receipt.comment.id }
    }
  }
}
