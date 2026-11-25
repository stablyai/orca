import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { WorkspaceRunContext } from '../../shared/work-items/task-source-context'
import type { AutomationDestination } from '../../shared/automations/ownership/automation-owner-precondition'
import type { CommandHandler } from '../dispatch/dispatch'
import {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationRunsPage,
  formatAutomationShow,
  printAutomationResult,
  type AutomationListPayload,
  type AutomationShowPayload
} from './automation-format'
import { printResult } from '../output/command-result-output'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { resolveAutomationDestination, routeAutomationCreate } from './automation-destination'
import {
  AUTOMATION_RUNS_PAGE_SIZE,
  automationRunsRpc,
  readAllAutomationRuns,
  readAutomationRunsPage
} from './automation-runs-paging'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveCurrentWorktreeSelector } from '../workspace-selection/workspace-selector'
import { getExplicitTarget } from './automation-target-flags'
import {
  getEnabledFlag,
  getOptionalProviderFlag,
  getPrecheckFlag,
  getProviderFlag,
  getSourceContextFlag,
  getWorkspaceModeFlag
} from './automation-handler-flags'
import {
  assertOnNoReusableSessionReuse,
  automationSessionReuseFlags
} from './automation-session-reuse-flags'
import { getExtraAgentArgsFlag } from './automation-extra-agent-args-flag'
import { assertAutomationFieldsSupported } from './automation-host-support'
import { assertAutomationSetupMode, getAutomationSetupFlag } from './automation-setup-flag'
import { getTimezoneFlags } from './automation-timezone-flag'
import {
  createBotAutomation,
  editedBotTarget,
  editNeedsBot,
  getBotAgentSetupEdit,
  getBotTargetEditFlags,
  getBotTargetFlags
} from './automation-bot-create'
import { findBot } from '../bots/bot'
import { writeStdoutLine } from '../output/stdout-line'
import { printSavedAutomation } from '../webhooks/webhooks'
import {
  AUTOMATION_EVENT_TRIGGER_HANDLERS,
  getCreateScheduleFlag,
  getEditScheduleFlag,
  getEventTriggersFlag,
  withWontFire
} from './automation-event-triggers-cli'
import { callerChat } from './automation-caller-chat'
import { getOnceFlags } from './automation-once-flag'
import { watchPrCreateFlags } from './automation-watch-pr'

type AutomationCreateParams = Omit<AutomationCreateInput, 'projectId' | 'timezone'> & {
  destination?: AutomationDestination
  repo?: string
  timezone?: string
  workspace?: string
}

type AutomationUpdateParams = AutomationUpdateInput & {
  repo?: string
  workspace?: string
}

async function resolveDefaultTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ repo?: string; workspace?: string; runContext?: WorkspaceRunContext }> {
  const target = await getExplicitTarget(flags, cwd, client)
  if (target.repo || target.workspace || client.isRemote) {
    return target
  }
  try {
    return { workspace: await resolveCurrentWorktreeSelector(cwd, client, 'workspace') }
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_ambiguous') {
      throw error
    }
    return {}
  }
}

// Read the authoritative owner for fencing; older hosts omit it and impose no precondition.
async function resolveAutomationMutationState(
  client: Parameters<CommandHandler>[0]['client'],
  id: string
): Promise<AutomationShowPayload> {
  const result = await client.call<AutomationShowPayload>('automation.show', { id })
  return result.result
}

export const AUTOMATION_HANDLERS: Record<string, CommandHandler> = {
  ...AUTOMATION_EVENT_TRIGGER_HANDLERS,
  'automations list': async ({ client, json }) => {
    const listed = await client.call<AutomationListPayload>('automation.list')
    printAutomationResult(await withWontFire(client, listed), json, formatAutomationList)
  },
  'automations show': async ({ flags, client, json }) => {
    const result = await client.call<AutomationShowPayload>('automation.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printAutomationResult(result, json, formatAutomationShow)
  },
  'automations create': async ({ flags, client, cwd, json }) => {
    const setupDecision = getAutomationSetupFlag(flags)
    const on = getEventTriggersFlag(flags)
    const once = getOnceFlags(flags)
    const schedule = getCreateScheduleFlag(flags, on, once)
    const bot = await getBotTargetFlags(flags, client, on, schedule, once)
    if (!bot && flags.has('item')) {
      throw new RuntimeClientError('invalid_argument', "--item goes with --bot: a bot's own item")
    }
    if (bot) {
      const saved = await createBotAutomation(client, flags, bot, schedule, on, once)
      printSavedAutomation(saved, json, on)
      return
    }
    const target = await resolveDefaultTarget(flags, cwd, client)
    const sourceContext = getSourceContextFlag(flags)
    const workspaceMode =
      getWorkspaceModeFlag(flags) ?? (target.workspace ? 'existing' : 'new_per_run')
    assertAutomationSetupMode(setupDecision, workspaceMode, flags)
    const sessionReuse = automationSessionReuseFlags(flags)
    assertOnNoReusableSessionReuse(sessionReuse)
    // Built before the destination read so a contradictory flag still fails without a runtime call.
    const create = {
      name: getRequiredStringFlag(flags, 'name'),
      prompt: getRequiredStringFlag(flags, 'prompt'),
      precheck: getPrecheckFlag(flags),
      agentId: getProviderFlag(flags),
      extraAgentArgs: getExtraAgentArgsFlag(flags),
      ...(setupDecision !== undefined ? { setupDecision } : {}),
      ...(target.runContext ? { runContext: target.runContext } : {}),
      ...(sourceContext !== undefined ? { sourceContext } : {}),
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode,
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      ...sessionReuse,
      ...getTimezoneFlags(flags),
      enabled: getEnabledFlag(flags),
      missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
      ...schedule
    } satisfies AutomationCreateParams
    await assertAutomationFieldsSupported(client, create)
    const { writer, params } = await routeAutomationCreate(client, target, create)
    if (writer !== client) {
      await assertAutomationFieldsSupported(writer, create)
    }
    // The caller's chat lives on this client's host, so only a local write names it.
    const result = await writer.call<{ automation: Automation }>('automation.create', {
      ...params,
      ...(writer === client ? callerChat() : {})
    })
    printAutomationResult(result, json, formatAutomationShow)
  },
  // The same create, with the rules and deadline a pull request watch stands for.
  'automations watch-pr': async (context) => {
    const selector = getOptionalStringFlag(context.flags, 'bot')
    if (!selector) {
      throw new RuntimeClientError('invalid_argument', 'watch-pr needs --bot <name>')
    }
    const { githubCiFinished } = await findBot(context.client, selector)
    const flags = watchPrCreateFlags(context.flags, Date.now(), githubCiFinished === true)
    await AUTOMATION_HANDLERS['automations create']({ ...context, flags })
  },
  'automations edit': async ({ flags, client, cwd, json }) => {
    const setupDecision = getAutomationSetupFlag(flags)
    const target = await getExplicitTarget(flags, cwd, client)
    const schedule = getEditScheduleFlag(flags)
    const on = getEventTriggersFlag(flags)
    const once = getOnceFlags(flags)
    const botEdits = getBotTargetEditFlags(flags)
    const agentEdit = getBotAgentSetupEdit(flags)
    const sourceContext = getSourceContextFlag(flags)
    const id = getRequiredStringFlag(flags, 'id')
    const sessionReuse = automationSessionReuseFlags(flags)
    // Built before the owner read so a contradictory flag still fails without a runtime call.
    const updates = {
      name: getOptionalStringFlag(flags, 'name'),
      prompt: getOptionalStringFlag(flags, 'prompt'),
      precheck: getPrecheckFlag(flags),
      agentId: getOptionalProviderFlag(flags),
      extraAgentArgs: getExtraAgentArgsFlag(flags),
      ...(setupDecision !== undefined ? { setupDecision } : {}),
      ...(target.runContext ? { runContext: target.runContext } : {}),
      ...(sourceContext !== undefined ? { sourceContext } : {}),
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode: getWorkspaceModeFlag(flags),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      ...sessionReuse,
      ...getTimezoneFlags(flags),
      enabled: getEnabledFlag(flags),
      missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
      ...(on ? { on } : {}),
      ...(once ? { once } : {}),
      ...schedule
    } satisfies AutomationUpdateParams
    await assertAutomationFieldsSupported(client, updates)
    const { owner: expectedOwner, automation: current } = await resolveAutomationMutationState(
      client,
      id
    )
    assertAutomationSetupMode(
      setupDecision,
      updates.workspaceMode ?? (target.workspace ? 'existing' : current.workspaceMode)
    )
    // The host takes the whole target, so the saved bot and the unchanged field go with the edit.
    const liveBot =
      current.bot && editNeedsBot(current, agentEdit)
        ? await findBot(client, current.bot.botId)
        : undefined
    const bot = editedBotTarget(current, botEdits, agentEdit, liveBot)
    assertOnNoReusableSessionReuse(sessionReuse, current)
    // Owner fencing covers the source host; moves must fence the destination too.
    const destination = await resolveAutomationDestination(client, target)
    const result = await client.call<{ automation: Automation }>('automation.update', {
      id,
      ...(expectedOwner ? { expectedOwner } : {}),
      ...(destination ? { destination } : {}),
      // A setup choice that relies on the current mode must not land after a switch to existing.
      ...(setupDecision && !updates.workspaceMode ? { expectedWorkspaceMode: 'new_per_run' } : {}),
      updates: bot ? { ...updates, bot } : updates,
      ...callerChat()
    })
    printSavedAutomation(result, json, on, current)
    const pinned = result.result.automation.bot?.agentSetup
    // Only a setup taken from the bot's current agent is a pin; another agent was asked for.
    if (liveBot && pinned?.agent === liveBot.agent && !json) {
      writeStdoutLine(
        `Pinned to ${liveBot.name}'s current agent (${pinned.agent}): this automation keeps it when ${liveBot.name} switches agents; --agent bot follows ${liveBot.name} again.`
      )
    }
  },
  'automations remove': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const { owner: expectedOwner } = await resolveAutomationMutationState(client, id)
    const result = await client.call<{ removed: boolean; id: string }>('automation.delete', {
      id,
      ...(expectedOwner ? { expectedOwner } : {})
    })
    printResult(result, json, formatAutomationRemoved)
  },
  'automations run': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const { owner: expectedOwner } = await resolveAutomationMutationState(client, id)
    const result = await client.call<{ run: AutomationRun }>('automation.runNow', {
      id,
      ...(expectedOwner ? { expectedOwner } : {})
    })
    const environment = getOptionalStringFlag(flags, 'environment') ?? process.env.ORCA_ENVIRONMENT
    const preserveConnectionSettings = Boolean(
      (client.isRemote && !environment) || process.env.ORCA_USER_DATA_PATH
    )
    printResult(
      { ...result, result: { ...result.result, runId: result.result.run.id } },
      json,
      (value) => formatAutomationRun(value, { environment, preserveConnectionSettings })
    )
  },
  'automations runs': async ({ flags, client, json }) => {
    const automationId = getOptionalStringFlag(flags, 'id')
    const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
    const cursor = getOptionalStringFlag(flags, 'cursor')
    if (limit === undefined && cursor === undefined) {
      printResult(
        await readAllAutomationRuns(automationRunsRpc(client), automationId),
        json,
        formatAutomationRuns
      )
      return
    }
    const page = await readAutomationRunsPage(automationRunsRpc(client), {
      automationId,
      limit: limit ?? AUTOMATION_RUNS_PAGE_SIZE,
      cursor
    })
    printResult(
      { ...page, result: { runs: page.result.runs, nextCursor: page.result.nextCursor ?? null } },
      json,
      formatAutomationRunsPage
    )
  }
}
