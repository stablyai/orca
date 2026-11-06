import { z } from 'zod'
import { AutomationDraftValidationError } from './automation-error'
import { getRepoMainWorktreeId } from '../../../src/shared/worktree/id'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../src/shared/worktree-execution-host-resolution'
import type { AutomationDestination } from '../../../src/shared/automation-owner-precondition'
import { buildWorkspaceRunContext } from '../../../src/shared/task-source-context'
import {
  PREFLIGHT_HOST_QUALIFIED_RUNTIME_CAPABILITY,
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY
} from '../../../src/shared/preflight-runtime-capabilities'
import { hostStatusProbe } from '../transport/host-status-probe-operations'
import {
  newTabRepoListRead,
  preflightDetectAgentsRead,
  preflightRefreshAgentsRead
} from '../session/mobile-session-read-operations'
import { buildMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-options'
import type { RpcClient } from '../transport/rpc-client'
import {
  automationAgentSettingsRead,
  automationWorkspacesRead,
  automationProjectsRead,
  automationSetupsRead,
  automationSshTargetsRead
} from './automation-operations'
import {
  workspaceSchema,
  type AutomationSetup,
  type AutomationWorkspace
} from './automation-reply-schema'

export const automationRepoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  kind: z.string().optional(),
  connectionId: z.string().nullish(),
  executionHostId: workspaceSchema.shape.hostId.nullable()
})

export async function loadAutomationTargets(client: RpcClient, limit = 200) {
  const [projects, setups, catalog, repos, ssh] = await Promise.all([
    automationProjectsRead.request(client),
    automationSetupsRead.request(client),
    automationWorkspacesRead.request(client, { limit }),
    newTabRepoListRead.request(client),
    automationSshTargetsRead.request(client)
  ])
  const workspaceReply = automationWorkspacesRead.interpret(catalog)
  const repoRows = newTabRepoListRead.interpret(repos).flatMap((raw) => {
    const parsed = automationRepoSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
  const repoLookup = createRepoRowExecutionHostLookup(repoRows)
  const projectRows = automationProjectsRead.interpret(projects).projects
  return {
    setups: automationSetupsRead.interpret(setups).setups.flatMap((setup) => {
      const repo = repoRows.find(
        (repo) =>
          repo.id === setup.repoId &&
          repo.path === setup.path &&
          getRepoExecutionHostId(repo) === setup.hostId
      )
      return setup.setupState === 'ready' && repo
        ? [
            {
              ...setup,
              label:
                projectRows.find((project) => project.id === setup.projectId)?.displayName ??
                setup.displayName,
              kind: setup.kind ?? repo.kind
            }
          ]
        : []
    }),
    workspaces: workspaceReply.worktrees.flatMap((raw) => {
      const row = z.object({ id: z.string() }).passthrough().safeParse(raw)
      const parsed = workspaceSchema.safeParse(
        row.success ? { ...row.data, worktreeId: row.data.id } : raw
      )
      if (!parsed.success || parsed.data.isArchived) {
        return []
      }
      const owner = resolveWorktreeExecutionHost(repoLookup, parsed.data)
      return owner.kind === 'resolved' ? [{ ...parsed.data, hostId: owner.hostId }] : []
    }),
    coverage: {
      limit,
      totalCount: workspaceReply.totalCount,
      truncated: workspaceReply.truncated,
      hostScope: workspaceReply.hostScope
    },
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
  throw new AutomationDraftValidationError('destination')
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

const agentAcquisitions = new WeakMap<RpcClient, Map<string, symbol>>()

export async function loadAutomationAgents(
  client: RpcClient,
  setup: AutomationSetup,
  workspaceId?: string,
  refresh = false
) {
  const host = parseExecutionHostId(setup.hostId)
  if (host?.kind !== 'local') {
    throw new Error(
      'Agent discovery is unavailable for this project host. Saved agent choices are preserved.'
    )
  }
  const key = JSON.stringify([automationSetupKey(setup), workspaceId])
  const pending = agentAcquisitions.get(client) ?? new Map<string, symbol>()
  agentAcquisitions.set(client, pending)
  const token = Symbol()
  pending.set(key, token)
  const generation = client.getGeneration?.()
  const requireCurrent = () => {
    if (generation !== client.getGeneration?.() || pending.get(key) !== token) {
      throw new Error('The host connection changed. Try again.')
    }
  }
  try {
    const status = hostStatusProbe.interpret(await hostStatusProbe.request(client))
    requireCurrent()
    const capabilities = status.accepted ? (status.value.capabilities ?? []) : []
    const worktreeId = workspaceId ?? getRepoMainWorktreeId({ id: setup.repoId, path: setup.path })
    const params = capabilities.includes(PREFLIGHT_HOST_QUALIFIED_RUNTIME_CAPABILITY)
      ? { worktreeId, worktreeHostId: host.id }
      : capabilities.includes(PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY)
        ? { worktreeId }
        : undefined
    if (
      !params &&
      (!status.accepted || !status.value.hostPlatform || status.value.hostPlatform === 'win32')
    ) {
      throw new Error(
        'This host cannot verify agents for this project. Update the host and try again.'
      )
    }
    const [settingsReply, detectedReply] = await Promise.all([
      automationAgentSettingsRead.request(client),
      refresh
        ? preflightRefreshAgentsRead.request(client, params)
        : preflightDetectAgentsRead.request(client, params)
    ])
    requireCurrent()
    const settings = automationAgentSettingsRead.interpret(settingsReply).settings
    const detected = refresh
      ? preflightRefreshAgentsRead.interpret(detectedReply)
      : preflightDetectAgentsRead.interpret(detectedReply)
    return buildMobileNewTabAgentOptions(settings, detected)
  } finally {
    if (pending.get(key) === token) {
      pending.delete(key)
    }
  }
}

export function automationSetupKey(
  setup: Pick<AutomationSetup, 'id' | 'hostId' | 'repoId' | 'path'>
): string {
  return JSON.stringify([setup.hostId, setup.id, setup.repoId, setup.path])
}
export function workspaceMatchesSetup(
  workspace: AutomationWorkspace,
  setup: AutomationSetup
): boolean {
  return workspace.repoId === setup.repoId && workspace.hostId === setup.hostId
}
