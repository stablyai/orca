import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../shared/automations-types'
import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../shared/task-source-context'
import type {
  AutomationDestination,
  AutomationOwnerPrecondition
} from '../../shared/automation-owner-precondition'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { CommandHandler } from '../dispatch'
import {
  formatAutomationList,
  formatAutomationRemoved,
  formatAutomationRun,
  formatAutomationRuns,
  formatAutomationShow,
  printResult,
  type AutomationShowPayload
} from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { resolveAutomationDestination } from '../automation-destination'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED,
  hasExtraAgentArgs
} from '../../shared/automation-extra-agent-args'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  resolveProjectCreateTarget
} from '../worktree-project-target'
import {
  getEnabledFlag,
  getOptionalProviderFlag,
  getPrecheckFlag,
  getProviderFlag,
  getReuseSessionFlag,
  getScheduleFlag,
  getSourceContextFlag,
  getWorkspaceModeFlag
} from './automation-handler-flags'
import { getExtraAgentArgsFlag } from './automation-extra-agent-args-flag'

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
  assertWorkspaceTargetFlagsCompatible(flags)
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError('invalid_argument', 'Use either --repo or --workspace, not both.')
  }
  if (hasWorkspaceProjectTarget(flags) && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --workspace or project target flags, not both.'
    )
  }
  const projectTarget = await resolveProjectCreateTarget(flags, client)
  if (projectTarget) {
    return {
      repo: projectTarget.repoSelector,
      runContext: buildAutomationRunContextFromSetup(projectTarget.setup)
    }
  }
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  if (repo || workspace) {
    return { repo, workspace }
  }
  if (client.isRemote) {
    return {}
  }
  try {
    return { workspace: await resolveCurrentWorktreeSelector(cwd, client) }
  } catch {
    return {}
  }
}

async function getExplicitTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ repo?: string; workspace?: string; runContext?: WorkspaceRunContext }> {
  assertWorkspaceTargetFlagsCompatible(flags)
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError('invalid_argument', 'Use either --repo or --workspace, not both.')
  }
  if (hasWorkspaceProjectTarget(flags) && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --workspace or project target flags, not both.'
    )
  }
  const projectTarget = await resolveProjectCreateTarget(flags, client)
  if (projectTarget) {
    return {
      repo: projectTarget.repoSelector,
      runContext: buildAutomationRunContextFromSetup(projectTarget.setup)
    }
  }
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  return { repo, workspace }
}

/**
 * Reads the record's current owner so the mutation that follows can name it.
 *
 * The CLI cannot project an owner itself — it has no SSH target registry — so it
 * asks the authority that stores the record. A host too old to answer sends
 * nothing, and that host has no fence to satisfy either.
 */
async function resolveExpectedOwner(
  client: Parameters<CommandHandler>[0]['client'],
  id: string
): Promise<AutomationOwnerPrecondition | undefined> {
  const result = await client.call<{ automation: Automation; owner?: AutomationOwnerPrecondition }>(
    'automation.show',
    { id }
  )
  return result.result.owner
}

function buildAutomationRunContextFromSetup(setup: ProjectHostSetup): WorkspaceRunContext {
  const runContext = buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path
  })
  if (!runContext) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Project host setup is missing automation run context fields: ${setup.id}`
    )
  }
  return runContext
}

// Why: an older runtime strips the field and would run the automation without it.
async function assertExtraAgentArgsSupported(
  client: RuntimeClient,
  extraAgentArgs: string | undefined
): Promise<void> {
  if (!hasExtraAgentArgs(extraAgentArgs)) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError('incompatible_runtime', EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED)
  }
}

export const AUTOMATION_HANDLERS: Record<string, CommandHandler> = {
  'automations list': async ({ client, json }) => {
    const result = await client.call<{ automations: Automation[] }>('automation.list')
    printResult(result, json, formatAutomationList)
  },
  'automations show': async ({ flags, client, json }) => {
    const result = await client.call<AutomationShowPayload>('automation.show', {
      id: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatAutomationShow)
  },
  'automations create': async ({ flags, client, cwd, json }) => {
    const schedule = getScheduleFlag(flags, true)
    if (!schedule) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --trigger')
    }
    const target = await resolveDefaultTarget(flags, cwd, client)
    const sourceContext = getSourceContextFlag(flags)
    const workspaceMode =
      getWorkspaceModeFlag(flags) ?? (target.workspace ? 'existing' : 'new_per_run')
    // Built before the destination read so a contradictory flag still fails without a runtime call.
    const create = {
      name: getRequiredStringFlag(flags, 'name'),
      prompt: getRequiredStringFlag(flags, 'prompt'),
      precheck: getPrecheckFlag(flags),
      agentId: getProviderFlag(flags),
      extraAgentArgs: getExtraAgentArgsFlag(flags),
      ...(target.runContext ? { runContext: target.runContext } : {}),
      ...(sourceContext !== undefined ? { sourceContext } : {}),
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode,
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      reuseSession: getReuseSessionFlag(flags),
      timezone: getOptionalStringFlag(flags, 'timezone'),
      enabled: getEnabledFlag(flags),
      missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
      ...schedule
    } satisfies AutomationCreateParams
    await assertExtraAgentArgsSupported(client, create.extraAgentArgs)
    const destination = await resolveAutomationDestination(client, target)
    const result = await client.call<{ automation: Automation }>('automation.create', {
      ...create,
      ...(destination ? { destination } : {})
    })
    printResult(result, json, formatAutomationShow)
  },
  'automations edit': async ({ flags, client, cwd, json }) => {
    const target = await getExplicitTarget(flags, cwd, client)
    const schedule = getScheduleFlag(flags, false)
    const sourceContext = getSourceContextFlag(flags)
    const id = getRequiredStringFlag(flags, 'id')
    // Built before the owner read so a contradictory flag still fails without a runtime call.
    const updates = {
      name: getOptionalStringFlag(flags, 'name'),
      prompt: getOptionalStringFlag(flags, 'prompt'),
      precheck: getPrecheckFlag(flags),
      agentId: getOptionalProviderFlag(flags),
      extraAgentArgs: getExtraAgentArgsFlag(flags),
      ...(target.runContext ? { runContext: target.runContext } : {}),
      ...(sourceContext !== undefined ? { sourceContext } : {}),
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode: getWorkspaceModeFlag(flags),
      baseBranch: getOptionalStringFlag(flags, 'base-branch'),
      reuseSession: getReuseSessionFlag(flags),
      timezone: getOptionalStringFlag(flags, 'timezone'),
      enabled: getEnabledFlag(flags),
      missedRunGraceMinutes: getOptionalPositiveIntegerFlag(flags, 'missed-run-grace-minutes'),
      ...schedule
    } satisfies AutomationUpdateParams
    await assertExtraAgentArgsSupported(client, updates.extraAgentArgs)
    const expectedOwner = await resolveExpectedOwner(client, id)
    // Why: expectedOwner only fences the host the record is leaving; an edit that moves it needs the arrival fenced too.
    const destination = await resolveAutomationDestination(client, target)
    const result = await client.call<{ automation: Automation }>('automation.update', {
      id,
      ...(expectedOwner ? { expectedOwner } : {}),
      ...(destination ? { destination } : {}),
      updates
    })
    printResult(result, json, formatAutomationShow)
  },
  'automations remove': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const expectedOwner = await resolveExpectedOwner(client, id)
    const result = await client.call<{ removed: boolean; id: string }>('automation.delete', {
      id,
      ...(expectedOwner ? { expectedOwner } : {})
    })
    printResult(result, json, formatAutomationRemoved)
  },
  'automations run': async ({ flags, client, json }) => {
    const id = getRequiredStringFlag(flags, 'id')
    const expectedOwner = await resolveExpectedOwner(client, id)
    const result = await client.call<{ run: AutomationRun }>('automation.runNow', {
      id,
      ...(expectedOwner ? { expectedOwner } : {})
    })
    printResult(result, json, formatAutomationRun)
  },
  'automations runs': async ({ flags, client, json }) => {
    const result = await client.call<{ runs: AutomationRun[] }>('automation.runs', {
      automationId: getOptionalStringFlag(flags, 'id')
    })
    printResult(result, json, formatAutomationRuns)
  }
}
