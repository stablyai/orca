// Shared by the local webhook tests: a bot automation with a hook's rule, and a loopback listen.
import type { Server } from 'node:http'
import type { Automation } from '../../../shared/automations/automation-definition'
import { webhookRuleId, type WebhookFilters } from '../../../shared/connector-webhook-contract'
import type { LocalHook } from './local-webhook-store'

export function webhookAutomation(
  hook: LocalHook,
  filters: WebhookFilters = {},
  enabled = true
): Automation {
  return {
    id: hook.automationId,
    name: 'Deploy hook',
    prompt: 'Look at the call.',
    precheck: null,
    agentId: 'claude',
    projectId: '',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    timezoneExplicit: true,
    rrule: '',
    dtstart: 1,
    enabled,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 60,
    createdAt: 1,
    updatedAt: 1,
    bot: { botId: hook.botId, runsIn: 'new', resultsTo: 'chat' },
    on: [{ id: webhookRuleId(hook.hookId), source: 'webhook', event: 'call', rev: 1, ...filters }]
  }
}

/** Listens on a free loopback port and returns it. */
export async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}
