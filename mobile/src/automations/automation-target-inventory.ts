import { z } from 'zod'
import { getRepoMainWorktreeId } from '../../../src/shared/worktree/id'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import type { AutomationDestination } from '../../../src/shared/automation-owner-precondition'
import { buildWorkspaceRunContext } from '../../../src/shared/task-source-context'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import {
  newTabRepoListRead,
  preflightDetectAgentsRead,
  preflightDetectRemoteAgentsRead
} from '../session/mobile-session-read-operations'
import { newTabSettingsRead } from '../transport/settings-read-operations'
import { buildMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-options'
import { loadMobileAgentLaunchContext } from '../session/mobile-new-tab-agent-loader'
import type { RpcClient } from '../transport/rpc-client'
import {
  automationProjectsRead,
  automationSetupsRead,
  automationSshTargetsRead
} from './automation-operations'
import {
  workspaceSchema,
  type AutomationSetup,
  type AutomationWorkspace
} from './automation-reply-schema'

const repoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  kind: z.string().optional()
})
const agentSettingsSchema = z.object({
  defaultTuiAgent: z.unknown().optional(),
  disabledTuiAgents: z.unknown().optional()
})

export async function loadAutomationTargets(client: RpcClient) {
  const [projects, setups, catalog, repos, ssh] = await Promise.all([
    automationProjectsRead.request(client),
    automationSetupsRead.request(client),
    worktreeCatalogRead.request(client),
    newTabRepoListRead.request(client),
    automationSshTargetsRead.request(client)
  ])
  const workspaceReply = worktreeCatalogRead.interpret(catalog)
  if (!workspaceReply.accepted || !workspaceReply.value.worktrees) {
    throw new Error('Could not read this host’s workspaces. Reconnect and try again.')
  }
  const repoRows = newTabRepoListRead.interpret(repos).flatMap((raw) => {
    const parsed = repoSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
  const projectRows = automationProjectsRead.interpret(projects).projects
  return {
    setups: automationSetupsRead
      .interpret(setups)
      .setups.filter(
        (setup) =>
          setup.setupState === 'ready' &&
          repoRows.some((repo) => repo.id === setup.repoId && repo.path === setup.path)
      )
      .map((setup) => ({
        ...setup,
        label:
          projectRows.find((project) => project.id === setup.projectId)?.displayName ??
          setup.displayName,
        kind: setup.kind ?? repoRows.find((repo) => repo.id === setup.repoId)?.kind
      })),
    workspaces: workspaceReply.value.worktrees.flatMap((raw) => {
      const parsed = workspaceSchema.safeParse(raw)
      return parsed.success && !parsed.data.isArchived ? [parsed.data] : []
    }),
    sshTargets: automationSshTargetsRead.interpret(ssh).targets
  }
}
export type AutomationTargets = Awaited<ReturnType<typeof loadAutomationTargets>>

export function automationTargetDestination(
  setup: AutomationSetup,
  workspace: AutomationWorkspace | undefined,
  targets: AutomationTargets
): AutomationDestination {
  const host = parseExecutionHostId(workspace?.hostId ?? setup.hostId)
  if (host?.kind === 'local') {
    return { selector: { kind: 'self' } }
  }
  if (host?.kind === 'ssh') {
    const target = targets.sshTargets.find((entry) => entry.id === host.targetId)
    if (target?.generation) {
      return { selector: { kind: 'ssh', targetId: target.id, targetGeneration: target.generation } }
    }
  }
  throw new Error('Select a project on this host or one of its registered SSH hosts.')
}

export function automationTargetContext(setup: AutomationSetup) {
  return buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path
  })
}

export async function loadAutomationAgents(
  client: RpcClient,
  setup: AutomationSetup,
  workspaceId?: string
) {
  if (workspaceId) {
    const context = await loadMobileAgentLaunchContext({
      client,
      worktreeId: workspaceId,
      hostRefusesOtherRuntime: true
    })
    const settings = agentSettingsSchema.safeParse(context.settings)
    return buildMobileNewTabAgentOptions(
      { disabledTuiAgents: settings.success ? settings.data.disabledTuiAgents : undefined },
      context.detectedAgents
    )
  }
  const host = parseExecutionHostId(setup.hostId)
  const detection =
    host?.kind === 'ssh'
      ? preflightDetectRemoteAgentsRead.request(client, { connectionId: host.targetId })
      : preflightDetectAgentsRead.request(client, {
          worktreeId: getRepoMainWorktreeId({ id: setup.repoId, path: setup.path })
        })
  const [settingsReply, detectedReply] = await Promise.all([
    newTabSettingsRead.request(client),
    detection
  ])
  const settings = agentSettingsSchema.safeParse(newTabSettingsRead.interpret(settingsReply)())
  const detected =
    host?.kind === 'ssh'
      ? preflightDetectRemoteAgentsRead.interpret(detectedReply)
      : preflightDetectAgentsRead.interpret(detectedReply)
  const defaultAgent = settings.success ? settings.data.defaultTuiAgent : undefined
  const available = buildMobileNewTabAgentOptions(
    { disabledTuiAgents: settings.success ? settings.data.disabledTuiAgents : undefined },
    detected
  )
  return [
    ...available.filter((entry) => entry.agent === defaultAgent),
    ...available.filter((entry) => entry.agent !== defaultAgent)
  ]
}
