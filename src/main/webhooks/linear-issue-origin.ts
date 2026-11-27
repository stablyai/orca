// Evidence observed at admission. Neither webhook content nor this snapshot is a write grant.
import type { LedgerCall, LedgerHook } from './webhook-host-ledger'
import type { Automation } from '../../shared/automations/automation-definition'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'
import type { LinearIssueIntake } from '../../shared/linear/issue-intake'
import {
  automationWebhookTrigger,
  type AutomationRunWebhookCall
} from '../../shared/automation-event-triggers'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import { isLinearUuid } from '../../shared/linear/uuid'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && isLinearUuid(value)
}

export function linearSeatAtReceipt(
  delivery: Extract<ConnectorDelivery, { kind: 'trigger' }>,
  hook: LedgerHook | undefined,
  automations: readonly Automation[]
): LedgerCall['linearAdmission'] {
  const fields = delivery.event.webhook
  if (
    !fields ||
    fields.sample ||
    !hook ||
    hook.state !== 'live' ||
    hook.epoch !== fields.epoch ||
    hook.automationId !== delivery.automationId
  ) {
    return
  }
  const target = automations.find((entry) => entry.id === hook.automationId)
  if (!target?.enabled || target.bot?.botId !== hook.botId) {
    return
  }
  const configuredBotId = hook.botId
  const rule = automationWebhookTrigger(target)
  if (
    !rule ||
    rule.id !== delivery.triggerId ||
    rule.id !== `wh-${hook.hookId}` ||
    rule.subjectFrom !== 'body.data.id' ||
    rule.subject !== undefined ||
    !uuid(configuredBotId)
  ) {
    return
  }
  const filters = rule.where?.filter((filter) => filter.path === 'body.data.projectId') ?? []
  const filter = filters[0]
  const project = filter?.values?.[0]
  const assignedProjectId =
    filters.length === 1 && filter.op === '=' && filter.values?.length === 1 && uuid(project)
      ? project
      : null
  return { configuredBotId, assignedProjectId, ruleRevision: rule.rev }
}

function captureLinearIssueIntake(
  envelope: WebhookEnvelope,
  call: Pick<LedgerCall, 'subject' | 'sample' | 'routed' | 'linearAdmission'>
): LinearIssueIntake | undefined {
  if (
    !call.linearAdmission ||
    call.sample ||
    call.routed ||
    envelope.truncated ||
    envelope.body.kind !== 'json'
  ) {
    return
  }
  const body = envelope.body.value
  if (
    !record(body) ||
    body.type !== 'Issue' ||
    !record(body.data) ||
    !uuid(body.organizationId) ||
    !uuid(body.data.id) ||
    body.data.id !== call.subject
  ) {
    return
  }

  return {
    sourceWorkspaceId: body.organizationId,
    sourceIssueKey:
      typeof body.data.identifier === 'string' &&
      LINEAR_ISSUE_KEY_PATTERN.test(body.data.identifier)
        ? body.data.identifier
        : null,
    sourceIssueId: body.data.id,
    sourceProjectId: uuid(body.data.projectId) ? body.data.projectId : null,
    ...call.linearAdmission
  }
}

export function webhookRunCall(
  envelope: WebhookEnvelope,
  call: Pick<
    LedgerCall,
    'hookId' | 'callId' | 'first' | 'sample' | 'subject' | 'routed' | 'linearAdmission'
  >
): AutomationRunWebhookCall {
  const origin = captureLinearIssueIntake(envelope, call)
  return {
    ...(origin ? { linearIssueIntake: origin } : {}),
    hookId: call.hookId,
    callId: call.callId,
    file: null,
    ...(call.sample ? { sample: true as const } : {}),
    ...(call.first ? { firstCall: true as const } : {})
  }
}
