// Evidence observed at admission. Neither webhook content nor this snapshot is a write grant.
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'
import type { LinearIssueIntake } from '../../shared/linear/issue-intake'
import type {
  AutomationRunWebhookCall,
  AutomationWebhookTrigger
} from '../../shared/automation-event-triggers'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import { isLinearUuid } from '../../shared/linear/uuid'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && isLinearUuid(value)
}

export function captureLinearIssueIntake(
  envelope: WebhookEnvelope,
  call: {
    callId: string
    hookId: string
    triggerId: string
    subject?: string
    sample?: true
    routed?: true
  },
  rule: AutomationWebhookTrigger | undefined,
  configuredBotId: string | undefined
): LinearIssueIntake | undefined {
  if (
    call.sample ||
    call.routed ||
    envelope.truncated ||
    envelope.body.kind !== 'json' ||
    !rule ||
    rule.id !== call.triggerId ||
    rule.id !== `wh-${call.hookId}` ||
    rule.subjectFrom !== 'body.data.id' ||
    rule.subject !== undefined ||
    !uuid(configuredBotId)
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

  const filters = rule.where?.filter((filter) => filter.path === 'body.data.projectId') ?? []
  const filter = filters[0]
  const project = filter?.values?.[0]
  const assignedProjectId =
    filters.length === 1 && filter.op === '=' && filter.values?.length === 1 && uuid(project)
      ? project
      : null
  return {
    sourceWorkspaceId: body.organizationId,
    sourceIssueKey:
      typeof body.data.identifier === 'string' &&
      LINEAR_ISSUE_KEY_PATTERN.test(body.data.identifier)
        ? body.data.identifier
        : null,
    sourceIssueId: body.data.id,
    sourceProjectId: uuid(body.data.projectId) ? body.data.projectId : null,
    configuredBotId,
    assignedProjectId,
    ruleRevision: rule.rev
  }
}

export function webhookRunCall(
  envelope: WebhookEnvelope,
  call: {
    callId: string
    hookId: string
    triggerId: string
    subject?: string
    first?: boolean
    sample?: true
    routed?: true
  },
  rule: AutomationWebhookTrigger | undefined,
  configuredBotId: string | undefined
): AutomationRunWebhookCall {
  const origin = captureLinearIssueIntake(envelope, call, rule, configuredBotId)
  return {
    ...(origin ? { linearIssueIntake: origin } : {}),
    hookId: call.hookId,
    callId: call.callId,
    file: null,
    ...(call.sample ? { sample: true as const } : {}),
    ...(call.first ? { firstCall: true as const } : {})
  }
}
