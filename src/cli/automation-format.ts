/**
 * Human-readable automation output for the CLI.
 *
 * The host lines come from the authority's own projection, never from the
 * stored `executionTarget*` fields: a target that was removed — or removed and
 * re-registered under the same id — leaves those fields untouched, so printing
 * them alone would render a dead host identically to a healthy one and leave
 * `orca automations show` unable to complete the recovery it is named in.
 */

import type { Automation, AutomationRun } from '../shared/automations-types'
import type { AutomationListItem } from '../shared/automation-list-scope'
import type { AutomationOwnerPrecondition } from '../shared/automation-owner-precondition'
import { getAutomationLegacyRepoId } from '../shared/automation-run-identity'
import { formatAutomationPrecheckTimeout } from '../shared/automation-precheck'
import { formatAutomationSchedule } from '../shared/automation-schedules'
import { quoteCliCommandArgument } from './shell-command-quote'

export type AutomationListPayload = {
  automations: Automation[]
  /** Present only when the authority qualifies its rows; an older host sends none. */
  items?: AutomationListItem[]
}

export type AutomationShowPayload = {
  automation: Automation
  /** Present only when the authority can project an owner; an older host sends none. */
  owner?: AutomationOwnerPrecondition
}

const ORPHAN_HOST_LABEL = 'orphan (no host can run this automation)'

function formatOwnerSelector(selector: AutomationOwnerPrecondition['selector']): string {
  if (selector.kind === 'ssh') {
    return `ssh:${selector.targetId} (generation ${selector.targetGeneration})`
  }
  return selector.kind === 'orphan' ? ORPHAN_HOST_LABEL : 'self'
}

function formatListItemSelector(item: AutomationListItem): string {
  const selector = item.selector
  if (selector.kind === 'ssh') {
    return `ssh:${selector.targetId} (generation ${selector.targetGeneration})`
  }
  return selector.kind === 'orphan' ? `orphan — ${selector.issue}` : 'self'
}

export function formatAutomationList(result: AutomationListPayload): string {
  if (result.automations.length === 0) {
    return 'No automations found.'
  }
  const hosts = new Map(result.items?.map((item) => [item.automationId, item]) ?? [])
  return result.automations
    .map((automation) => {
      const status = automation.enabled ? 'enabled' : 'disabled'
      const item = hosts.get(automation.id)
      const host = item ? `\nhost: ${formatListItemSelector(item)}` : ''
      return `${automation.id}  ${automation.name}  ${automation.agentId}  ${status}\n${formatAutomationSchedule(automation.rrule)}  next: ${new Date(automation.nextRunAt).toISOString()}${host}`
    })
    .join('\n\n')
}

export function formatAutomationShow(result: AutomationShowPayload): string {
  const automation = result.automation
  const runContext = automation.runContext ?? null
  const projectLines = runContext
    ? [
        `runProjectId: ${runContext.projectId}`,
        `runHostId: ${runContext.hostId}`,
        `projectHostSetupId: ${runContext.projectHostSetupId}`,
        `runRepoId: ${runContext.repoId}`,
        `runPath: ${runContext.path}`,
        `legacyRepoId: ${getAutomationLegacyRepoId(automation)}`
      ]
    : [`legacyRepoId: ${getAutomationLegacyRepoId(automation)}`]
  return [
    `id: ${automation.id}`,
    `name: ${automation.name}`,
    `provider: ${automation.agentId}`,
    ...(automation.extraAgentArgs ? [`extraAgentArgs: ${automation.extraAgentArgs}`] : []),
    `enabled: ${automation.enabled}`,
    `schedule: ${formatAutomationSchedule(automation.rrule)}`,
    `rrule: ${automation.rrule}`,
    `precheck: ${
      automation.precheck
        ? `${automation.precheck.command} (timeout ${formatAutomationPrecheckTimeout(
            automation.precheck.timeoutSeconds
          )})`
        : 'none'
    }`,
    `nextRunAt: ${new Date(automation.nextRunAt).toISOString()}`,
    ...projectLines,
    `workspaceMode: ${automation.workspaceMode}`,
    `workspaceId: ${automation.workspaceId ?? 'null'}`,
    `baseBranch: ${automation.baseBranch ?? 'null'}`,
    `reuseSession: ${automation.reuseSession}`,
    `target: ${automation.executionTargetType}:${automation.executionTargetId}`,
    // Omitted rather than guessed: a host that reports no owner has none to report.
    ...(result.owner ? [`host: ${formatOwnerSelector(result.owner.selector)}`] : []),
    `prompt: ${automation.prompt}`
  ].join('\n')
}

export function formatAutomationRemoved(result: { removed: boolean; id: string }): string {
  return result.removed
    ? `Removed automation ${result.id}.`
    : `Automation ${result.id} not removed.`
}

function formatAutomationRunAcknowledgement(run: { id: string; status: string }): string {
  switch (run.status) {
    case 'pending':
      return `Queued run ${run.id} (pending).`
    case 'dispatching':
      return `Accepted run ${run.id}; launch is still in progress (dispatching).`
    case 'dispatched':
      return `Started run ${run.id} (dispatched).`
    case 'completed':
      return `Completed run ${run.id}.`
    case 'dispatch_failed':
      return `Run ${run.id} failed (dispatch_failed).`
    case 'skipped_precheck':
    case 'skipped_missed':
    case 'skipped_unavailable':
    case 'skipped_needs_interactive_auth':
      return `Skipped run ${run.id} (${run.status}).`
    default:
      return `Run ${run.id}: ${run.status}.`
  }
}

type AutomationRunFollowUpTarget = {
  environment?: string
  preserveConnectionSettings?: boolean
}

function formatAutomationRunFollowUp(
  automationId: string,
  target: AutomationRunFollowUpTarget
): string {
  const command = ['orca', 'automations', 'runs', '--id', quoteCliCommandArgument(automationId)]
  // Windows shells can expand a label even inside double quotes.
  const safeEnvironment =
    target.environment &&
    !target.environment.startsWith('--') &&
    (process.platform !== 'win32' || /^[a-zA-Z0-9._:/@ -]+$/.test(target.environment))
  if (target.environment && safeEnvironment) {
    command.push('--environment', quoteCliCommandArgument(target.environment))
  }
  const prefix =
    target.preserveConnectionSettings || (target.environment && !safeEnvironment)
      ? 'Follow up on the same host and profile (preserve your connection/profile settings)'
      : 'Follow up'
  return `${prefix}: ${command.join(' ')}`
}

export function formatAutomationRun(
  result: { run: AutomationRun },
  target: AutomationRunFollowUpTarget = {}
): string {
  return [
    formatAutomationRunAcknowledgement(result.run),
    `id: ${result.run.id}`,
    `automationId: ${result.run.automationId}`,
    `title: ${result.run.title}`,
    `status: ${result.run.status}`,
    `trigger: ${result.run.trigger}`,
    `scheduledFor: ${new Date(result.run.scheduledFor).toISOString()}`,
    ...(result.run.workspaceId ? [`workspaceId: ${result.run.workspaceId}`] : []),
    ...(result.run.terminalSessionId ? [`terminalSessionId: ${result.run.terminalSessionId}`] : []),
    ...(result.run.terminalPaneKey ? [`terminalPaneKey: ${result.run.terminalPaneKey}`] : []),
    ...(result.run.terminalPtyId ? [`terminalPtyId: ${result.run.terminalPtyId}`] : []),
    ...(result.run.precheckResult ? [`precheck: ${formatAutomationRunPrecheck(result.run)}`] : []),
    ...(result.run.error ? [`error: ${result.run.error}`] : []),
    formatAutomationRunFollowUp(result.run.automationId, target)
  ].join('\n')
}

function formatAutomationRunPrecheck(run: AutomationRun): string {
  const result = run.precheckResult
  if (!result) {
    return 'none'
  }
  const outcome = result.timedOut
    ? 'timed out'
    : result.error
      ? 'error'
      : `exit ${result.exitCode ?? 'unknown'}`
  const output = result.stderr.trim() || result.stdout.trim()
  return output ? `${outcome}; ${output}` : outcome
}

export function formatAutomationRunsPage(result: {
  runs: AutomationRun[]
  nextCursor: string | null
}): string {
  const runs = formatAutomationRuns(result)
  return result.nextCursor ? `${runs}\n\nNext page: --cursor ${result.nextCursor}` : runs
}

export function formatAutomationRuns(result: { runs: AutomationRun[] }): string {
  if (result.runs.length === 0) {
    return 'No automation runs found.'
  }
  return result.runs
    .map(
      (run) =>
        `${run.id}  ${run.automationId}  ${run.status}  ${run.trigger}  ${new Date(run.scheduledFor).toISOString()}\n${run.title}${run.precheckResult ? `\nprecheck: ${formatAutomationRunPrecheck(run)}` : ''}${run.error ? `\nerror: ${run.error}` : ''}`
    )
    .join('\n\n')
}
