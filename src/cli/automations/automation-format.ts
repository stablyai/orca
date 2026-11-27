// Use authority-projected owners: stored target fields survive host removal and re-registration.

import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { AutomationListItem } from '../../shared/automations/ownership/automation-list-scope'
import type { AutomationOwnerPrecondition } from '../../shared/automations/ownership/automation-owner-precondition'
import { getAutomationLegacyRepoId } from '../../shared/automations/history/automation-run-identity'
import { formatAutomationPrecheckTimeout } from '../../shared/automations/launch/automation-precheck'
import { formatAutomationSchedule } from '../../shared/automations/scheduling/automation-schedules'
import { hasAutomationSchedule } from '../../shared/automation-event-triggers'
import {
  describeAutomationEventTrigger,
  formatAutomationEventTrigger
} from './automation-event-trigger-spec'
import { quoteCliCommandArgument } from '../arguments/shell-command-quote'
import { BOT_CHAT_ID_PREFIX } from '../../shared/bots/bot-chat-row'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { printResult } from '../output/command-result-output'
import { formatLocalTime } from '../output/local-time'

export type AutomationListPayload = {
  automations: Automation[]
  /** Present only when the authority qualifies its rows; an older host sends none. */
  items?: AutomationListItem[]
  /** Added by the CLI: why a bot automation's event rules never fire, by automation id. */
  wontFire?: Record<string, string>
  /** Waits whose one run has started; an older host sends none. */
  firedWaits?: string[]
}

export type AutomationShowPayload = {
  automation: Automation
  /** Present only when the authority can project an owner; an older host sends none. */
  owner?: AutomationOwnerPrecondition
}

/** An event-only automation stores a placeholder schedule so older Orcas never run it; JSON shows none. */
export function automationJson(automation: Automation) {
  return hasAutomationSchedule(automation)
    ? automation
    : { ...automation, rrule: null, dtstart: null, nextRunAt: null }
}

/** printResult for automation payloads, whose JSON shows an event-only automation with no schedule. */
export function printAutomationResult<
  TResult extends Pick<AutomationListPayload, 'automations'> | { automation: Automation }
>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  if (!json) {
    printResult(response, false, formatter)
    return
  }
  const { result } = response
  const shown =
    'automations' in result
      ? { ...result, automations: result.automations.map(automationJson) }
      : result.automation
        ? { ...result, automation: automationJson(result.automation) }
        : result
  printResult({ ...response, result: shown }, true, () => '')
}

/** "agent: codex · gpt-6.1-terra · effort high (own)", or the bot's when it has none. */
function formatBotAgent(target: NonNullable<Automation['bot']>): string {
  if (target.runsIn !== 'new') {
    return "agent: the chat's (a run continues the chat on its agent)"
  }
  const setup = target.agentSetup
  if (!setup) {
    return "agent: the bot's"
  }
  const choices = [
    setup.launch?.model,
    ...Object.entries(setup.launch?.options ?? {}).map(([key, value]) => `${key} ${value}`)
  ].filter(Boolean)
  return `agent: ${[setup.agent, ...choices].join(' · ')} (own)`
}

// An event-only automation keeps a schedule no Orca reaches; show what starts it instead.
function formatWhen(automation: Automation): string {
  const events = (automation.on ?? []).map(describeAutomationEventTrigger)
  if (automation.once) {
    return `${formatOnce(automation)}${events.length > 0 ? `: ${events.join('; ')}` : ''}`
  }
  if (!hasAutomationSchedule(automation)) {
    return events.length > 0 ? `runs on events: ${events.join('; ')}` : 'never runs'
  }
  const schedule = `${formatAutomationSchedule(automation.rrule)}  next: ${new Date(automation.nextRunAt).toISOString()}`
  return events.length > 0 ? `${schedule}  also on ${events.length} event(s)` : schedule
}

// A wait: one run, then Orca deletes it.
function formatOnce(automation: Automation): string {
  const by = automation.once?.by
  if (by === undefined) {
    return `runs once, only on an event (ends unrun 30 days after it was made)`
  }
  // A reminder: no event, so only its time starts it.
  return (automation.on ?? []).length === 0
    ? `runs once at ${formatLocalTime(by, true)}`
    : `runs once, on an event or at ${new Date(by).toISOString()}, whichever comes first`
}

/** A bot automation that runs in a chosen chat, as --runs-in takes it, with that chat's saved title. */
function formatRunsInChat(automation: Automation): string | null {
  const chat = automation.bot?.chat
  return chat
    ? `runs in: ${BOT_CHAT_ID_PREFIX}${chat.sessionId}${chat.title ? `  ${JSON.stringify(chat.title)}` : ''}`
    : null
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
  const fired = new Set(result.firedWaits)
  return result.automations
    .map((automation) => {
      const status = fired.has(automation.id)
        ? 'fired (removed when its run finishes)'
        : automation.enabled
          ? 'enabled'
          : 'disabled'
      const item = hosts.get(automation.id)
      const host = item ? `\nhost: ${formatListItemSelector(item)}` : ''
      const wontFire = result.wontFire?.[automation.id]
      const inChat = formatRunsInChat(automation)
      return `${automation.id}  ${automation.name}  ${automation.agentId}  ${status}\n${formatWhen(automation)}${inChat ? `\n${inChat}` : ''}${wontFire ? `\n${wontFire}` : ''}${host}`
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
    ...(automation.bot ? [formatBotAgent(automation.bot)] : []),
    ...(automation.extraAgentArgs ? [`extraAgentArgs: ${automation.extraAgentArgs}`] : []),
    `enabled: ${automation.enabled}`,
    ...(automation.bot
      ? [formatRunsInChat(automation) ?? `runs in: ${automation.bot.runsIn}`]
      : []),
    ...(automation.once ? [`once: ${formatOnce(automation)}`] : []),
    ...(hasAutomationSchedule(automation)
      ? [`schedule: ${formatAutomationSchedule(automation.rrule)}`, `rrule: ${automation.rrule}`]
      : [`schedule: none${automation.on?.length ? ' (runs on events)' : ''}`]),
    // The --on value to keep it, then what it means.
    ...(automation.on ?? []).map(
      (trigger) =>
        `on: ${quoteCliCommandArgument(formatAutomationEventTrigger(trigger))}  (when ${describeAutomationEventTrigger(trigger)})`
    ),
    `precheck: ${
      automation.precheck
        ? `${automation.precheck.command} (timeout ${formatAutomationPrecheckTimeout(
            automation.precheck.timeoutSeconds
          )})`
        : 'none'
    }`,
    ...(hasAutomationSchedule(automation)
      ? [`nextRunAt: ${new Date(automation.nextRunAt).toISOString()}`]
      : []),
    ...projectLines,
    `workspaceMode: ${automation.workspaceMode}`,
    // The saved choice only: what an unset choice does depends on the host's Orca version.
    ...(automation.workspaceMode === 'new_per_run'
      ? [`setup: ${automation.setupDecision ?? 'not set'}`]
      : []),
    `workspaceId: ${automation.workspaceId ?? 'null'}`,
    `baseBranch: ${automation.baseBranch ?? 'null'}`,
    `reuseSession: ${automation.reuseSession}`,
    `target: ${automation.executionTargetType}:${automation.executionTargetId}`,
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
