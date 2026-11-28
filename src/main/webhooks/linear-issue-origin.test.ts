import { describe, expect, it } from 'vitest'
import type { AutomationWebhookTrigger } from '../../shared/automation-event-triggers'
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'
import { linearAssignmentMatches, linearIntakeAtStart, webhookRunCall } from './linear-issue-origin'

const botId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const issueId = '00000000-0000-4000-8000-000000000003'
const workspaceId = '00000000-0000-4000-8000-000000000004'
const other = '00000000-0000-4000-8000-000000000005'
const rule: AutomationWebhookTrigger = {
  id: 'wh-test',
  rev: 3,
  source: 'webhook',
  event: 'call',
  subjectFrom: 'body.data.id',
  where: [{ path: 'body.data.projectId', op: '=', values: [projectId] }]
}
const target = {
  enabled: true,
  bot: { botId, runsIn: 'chat', resultsTo: 'chat' } as const,
  on: [rule]
}
const call = {
  hookId: 'test',
  callId: 'call',
  subject: issueId,
  linearAdmission: { configuredBotId: botId, assignedProjectId: projectId, ruleRevision: rule.rev }
}
const envelope: WebhookEnvelope = {
  receivedAt: 0,
  headers: {},
  truncated: false,
  contentType: 'application/json',
  body: {
    kind: 'json',
    value: {
      type: 'Issue',
      organizationId: workspaceId,
      data: { identifier: 'TEST-1', id: issueId, projectId }
    }
  }
}

describe('Linear assignment across webhook startup', () => {
  it.each([
    ['bot', { ...target, bot: { ...target.bot, botId: other } }],
    ['rule revision', { ...target, on: [{ ...rule, rev: rule.rev + 1 }] }],
    [
      'project',
      {
        ...target,
        on: [
          { ...rule, where: [{ path: 'body.data.projectId', op: '=' as const, values: [other] }] }
        ]
      }
    ]
  ] satisfies [string, NonNullable<Parameters<typeof webhookRunCall>[2]>][])(
    'retains a %s mismatch even if configuration is restored before create',
    (_, changed) => {
      const intake = webhookRunCall(envelope, call, changed).linearIssueIntake!
      expect(intake.sourceIssueId).toBe(issueId)
      expect(intake.assignedProjectId).toBeNull()
      expect(linearAssignmentMatches(intake, target, call.hookId, botId)).toBe(false)
    }
  )
  it('pins the actual receiving bot and keeps an ambiguous admission denied', () => {
    const valid = webhookRunCall(envelope, call, target).linearIssueIntake!
    expect(linearAssignmentMatches(valid, target, call.hookId, botId)).toBe(true)
    const wrongReceiver = linearIntakeAtStart(valid, target, call.hookId, other)
    expect(linearAssignmentMatches(wrongReceiver, target, call.hookId, botId)).toBe(false)
    const ambiguous = {
      ...call,
      linearAdmission: { ...call.linearAdmission, assignedProjectId: null }
    }
    expect(
      webhookRunCall(envelope, ambiguous, target).linearIssueIntake?.assignedProjectId
    ).toBeNull()
  })
})
