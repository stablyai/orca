import {
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  WORKSPACE_ON_OTHER_RUNTIME
} from '../../../src/shared/protocol-version'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost
} from '../../../src/shared/folder-workspace-execution-host'
import {
  newTabFolderWorkspaceListRead,
  newTabFolderProjectGroupListRead,
  newTabFolderRepoListRead
} from './mobile-new-tab-folder-host-operations'
import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { newTabSettingsRead } from '../transport/settings-read-operations'
import {
  type MobileRuntimeRepoSummary,
  newTabRepoListRead,
  preflightDetectAgentsRead,
  preflightDetectRemoteAgentsRead,
  preflightRefreshAgentsRead
} from './mobile-session-read-operations'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import {
  buildMobileNewTabAgentOptions,
  type MobileNewTabAgentOption,
  type MobileNewTabAgentSettings
} from './mobile-new-tab-agent-options'

const WORKSPACE_ON_OTHER_RUNTIME_MESSAGE =
  'This workspace runs on another Orca server. Pair that server directly to see its agents.'

/** The paired host does not own this workspace, so its agents are unverifiable from here. */
export class MobileWorkspaceOnOtherRuntimeError extends Error {
  constructor() {
    super(WORKSPACE_ON_OTHER_RUNTIME_MESSAGE)
    this.name = 'MobileWorkspaceOnOtherRuntimeError'
  }
}

/** What a launch in this workspace can choose from: the host's settings, the agents detected on
 *  the workspace's execution host, and the workspace's repo (absent for the floating workspace). */
export type MobileAgentLaunchContext = {
  settings: unknown
  detectedAgents: unknown[]
  repo: MobileRuntimeRepoSummary | null
}

export function hostRefusesOtherRuntimeWorkspace(
  hostCapabilities: readonly string[] | null | undefined
): boolean {
  return hostCapabilities?.includes(PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY) === true
}

type MobileAgentLaunchContextArgs = {
  client: RpcClient
  worktreeId: string
  /** Whether the host refuses, rather than answers for, a workspace another runtime owns. */
  hostRefusesOtherRuntime?: boolean
  /** Re-reads the host's login-shell PATH before probing, as desktop's refresh does. */
  refresh?: boolean
}

export async function loadMobileAgentLaunchContext(
  args: MobileAgentLaunchContextArgs
): Promise<MobileAgentLaunchContext> {
  const { client, worktreeId } = args
  // Started before the settings read, not inside the array: the detection request goes on the wire
  // first, and the recorded sender order is what says so.
  const detectedAgentsRequest = loadDetectedAgents(client, worktreeId, args)
  const [settingsResponse, detectedAgents] = await Promise.all([
    newTabSettingsRead.request(client),
    detectedAgentsRequest
  ])
  const readSettings = newTabSettingsRead.interpret(settingsResponse)
  // Interpreted after the group, not inside it: whichever peer failed first must not decide the
  // error the sheet shows, and main raised the detection refusal only once settings had settled.
  const detected = interpretDetectedAgents(detectedAgents)
  return { settings: readSettings(), detectedAgents: detected, repo: detectedAgents.repo }
}

/** The drawer's options and the detection they came from, which a later opening can reuse. */
export type MobileNewTabAgentInventory = Pick<MobileAgentLaunchContext, 'detectedAgents'> & {
  options: MobileNewTabAgentOption[]
}

export async function loadMobileNewTabAgentOptions(
  args: MobileAgentLaunchContextArgs & { settled?: MobileNewTabAgentInventory | null }
): Promise<MobileNewTabAgentInventory> {
  // Why settings every time: desktop reads them live, while a settled detection stands until refreshed.
  if (args.settled) {
    const reply = await newTabSettingsRead.request(args.client)
    return newTabAgentInventory(newTabSettingsRead.interpret(reply)(), args.settled.detectedAgents)
  }
  const context = await loadMobileAgentLaunchContext(args)
  return newTabAgentInventory(context.settings, context.detectedAgents)
}

function newTabAgentInventory(
  settings: unknown,
  detectedAgents: unknown[]
): MobileNewTabAgentInventory {
  return {
    options: buildMobileNewTabAgentOptions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
      settings as MobileNewTabAgentSettings | undefined,
      detectedAgents
    ),
    detectedAgents
  }
}

/** The reply and the operation that reads it: two methods detect agents and each reads its own. */
type DetectedAgentsReply = {
  reply: RpcResponse
  interpret: (reply: RpcResponse) => unknown[]
  repo: MobileRuntimeRepoSummary | null
}

async function loadDetectedAgents(
  client: RpcClient,
  worktreeId: string,
  host: Pick<MobileAgentLaunchContextArgs, 'hostRefusesOtherRuntime' | 'refresh'>
): Promise<DetectedAgentsReply> {
  // Why: the floating workspace runs on the paired host, so it has no repo connection to resolve.
  if (isFloatingWorkspaceWorktreeId(worktreeId)) {
    return { ...(await probeHostAgents(client, undefined, host.refresh)), repo: null }
  }
  if (worktreeId.startsWith('folder:')) {
    return loadFolderDetectedAgents(client, worktreeId, host)
  }
  const repoResponse = await newTabRepoListRead.request(client)
  const repos: MobileRuntimeRepoSummary[] = newTabRepoListRead.interpret(repoResponse)
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  const repo = repos.find((candidate) => candidate.id === repoId)
  if (!repo) {
    throw new Error('worktree_repo_not_found')
  }
  const runtimeOwned = repos
    .filter((candidate) => candidate.id === repoId)
    .map((candidate) => candidate.executionHostId?.startsWith('runtime:') === true)
  if (runtimeOwned.includes(true)) {
    // Why: rows on several hosts can share a repo id, and then only a host that refuses another
    // runtime's workspace may decide; the first row's connection could name this host's SSH target.
    if (!host.hostRefusesOtherRuntime || !runtimeOwned.includes(false)) {
      throw new MobileWorkspaceOnOtherRuntimeError()
    }
    return { ...(await probeHostAgents(client, { worktreeId }, host.refresh)), repo }
  }
  const connectionId = repo.connectionId?.trim() || null
  return connectionId
    ? {
        reply: await preflightDetectRemoteAgentsRead.request(client, { connectionId }),
        interpret: preflightDetectRemoteAgentsRead.interpret,
        repo
      }
    : {
        // Why the workspace: the host resolves its project runtime (a WSL distro on Windows). An
        // older host discards the params and answers with its own default, as it always has.
        ...(await probeHostAgents(client, { worktreeId }, host.refresh)),
        repo
      }
}

/** Desktop's `refreshRuntimeDetectedAgents` call: refresh, and detect only where the host lacks it. */
async function probeHostAgents(
  client: RpcClient,
  params: { worktreeId: string } | undefined,
  refresh: boolean | undefined
): Promise<Omit<DetectedAgentsReply, 'repo'>> {
  if (refresh) {
    const reply = await (params
      ? preflightRefreshAgentsRead.request(client, params)
      : preflightRefreshAgentsRead.request(client))
    // Why only this refusal: retrying a disconnect or a host failure doubles the work for nothing.
    if (reply.ok || !isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
      return { reply, interpret: preflightRefreshAgentsRead.interpret }
    }
  }
  return {
    reply: await (params
      ? preflightDetectAgentsRead.request(client, params)
      : preflightDetectAgentsRead.request(client)),
    interpret: preflightDetectAgentsRead.interpret
  }
}

function interpretDetectedAgents(detected: DetectedAgentsReply): unknown[] {
  try {
    return detected.interpret(detected.reply)
  } catch (error) {
    // A host with the refusal answers it for a workspace another runtime owns.
    if (error instanceof Error && error.message === WORKSPACE_ON_OTHER_RUNTIME) {
      throw new MobileWorkspaceOnOtherRuntimeError()
    }
    throw error
  }
}

async function loadFolderDetectedAgents(
  client: RpcClient,
  worktreeId: string,
  {
    hostRefusesOtherRuntime,
    refresh
  }: Pick<MobileAgentLaunchContextArgs, 'hostRefusesOtherRuntime' | 'refresh'>
): Promise<DetectedAgentsReply> {
  if (hostRefusesOtherRuntime) {
    return { ...(await probeHostAgents(client, { worktreeId }, refresh)), repo: null }
  }
  // Older hosts ignore worktreeId during detection, so resolve their folder catalog first.
  const [folders, groups, repos] = await Promise.all([
    newTabFolderWorkspaceListRead.request(client),
    newTabFolderProjectGroupListRead.request(client),
    newTabFolderRepoListRead.request(client)
  ])
  const catalog = {
    folderWorkspaces: newTabFolderWorkspaceListRead.interpret(folders),
    projectGroups: newTabFolderProjectGroupListRead.interpret(groups),
    repos: newTabFolderRepoListRead.interpret(repos)
  }
  const folderId = worktreeId.slice('folder:'.length)
  const workspaces = catalog.folderWorkspaces.filter((workspace) => workspace.id === folderId)
  if (workspaces.length > 1) {
    throw new Error('worktree_execution_host_unresolved')
  }
  const workspace = workspaces[0]
  const explicitHost = parseExecutionHostId(workspace?.executionHostId)
  const groupsForWorkspace = catalog.projectGroups.filter(
    (entry) => entry.id === workspace?.projectGroupId
  )
  if (!explicitHost && groupsForWorkspace.length > 1) {
    throw new Error('worktree_execution_host_unresolved')
  }
  const group = groupsForWorkspace[0]
  // A legacy host cannot disambiguate another runtime's rows or address its private SSH targets.
  if (
    workspaces.some((entry) => entry.executionHostId?.startsWith('runtime:')) ||
    (!explicitHost &&
      ((!workspace?.connectionId?.trim() && group?.executionHostId?.startsWith('runtime:')) ||
        findFolderWorkspaceCandidateRepos(catalog, folderId).some((repo) =>
          repo.executionHostId?.startsWith('runtime:')
        )))
  ) {
    throw new MobileWorkspaceOnOtherRuntimeError()
  }
  const host = resolveFolderWorkspaceHost(catalog, folderId)
  if (host.kind === 'runtime') {
    throw new MobileWorkspaceOnOtherRuntimeError()
  }
  if (host.kind === 'missing' || host.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  return host.kind === 'ssh'
    ? {
        reply: await preflightDetectRemoteAgentsRead.request(client, {
          connectionId: host.targetId
        }),
        interpret: preflightDetectRemoteAgentsRead.interpret,
        repo: null
      }
    : { ...(await probeHostAgents(client, { worktreeId }, refresh)), repo: null }
}
