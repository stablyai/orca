import {
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  WORKSPACE_ON_OTHER_RUNTIME
} from '../../../src/shared/protocol-version'
import { newTabSettingsRead } from '../transport/settings-read-operations'
import {
  type MobileRuntimeRepoSummary,
  newTabRepoListRead,
  preflightDetectAgentsRead,
  preflightDetectRemoteAgentsRead
} from './mobile-session-read-operations'
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
}

export async function loadMobileAgentLaunchContext(
  args: MobileAgentLaunchContextArgs
): Promise<MobileAgentLaunchContext> {
  const { client, worktreeId } = args
  // Started before the settings read, not inside the array: the detection request goes on the wire
  // first, and the recorded sender order is what says so.
  const detectedAgentsRequest = loadDetectedAgents(client, worktreeId, args.hostRefusesOtherRuntime)
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

export async function loadMobileNewTabAgentOptions(
  args: MobileAgentLaunchContextArgs
): Promise<MobileNewTabAgentOption[]> {
  const context = await loadMobileAgentLaunchContext(args)
  return buildMobileNewTabAgentOptions(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    context.settings as MobileNewTabAgentSettings | undefined,
    context.detectedAgents
  )
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
  hostRefusesOtherRuntime = false
): Promise<DetectedAgentsReply> {
  // Why: the floating workspace runs on the paired host, so it has no repo connection to resolve.
  if (isFloatingWorkspaceWorktreeId(worktreeId)) {
    return {
      reply: await preflightDetectAgentsRead.request(client),
      interpret: preflightDetectAgentsRead.interpret,
      repo: null
    }
  }
  const repoResponse = await newTabRepoListRead.request(client)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  const repos = (newTabRepoListRead.interpret(repoResponse) as MobileRuntimeRepoSummary[]) ?? []
  const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
  const repo = repos.find((candidate) => candidate.id === repoId)
  if (!repo) {
    throw new Error('worktree_repo_not_found')
  }
  // A prefix test, not parseExecutionHostId: importing execution-host here splits a web bundle chunk.
  const runtimeOwned = repos
    .filter((candidate) => candidate.id === repoId)
    .map((candidate) => candidate.executionHostId?.startsWith('runtime:') === true)
  if (runtimeOwned.includes(true)) {
    // Why: rows on several hosts can share a repo id, and then only a host that refuses another
    // runtime's workspace may decide; the first row's connection could name this host's SSH target.
    if (!hostRefusesOtherRuntime || !runtimeOwned.includes(false)) {
      throw new MobileWorkspaceOnOtherRuntimeError()
    }
    return {
      reply: await preflightDetectAgentsRead.request(client, { worktreeId }),
      interpret: preflightDetectAgentsRead.interpret,
      repo
    }
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
        reply: await preflightDetectAgentsRead.request(client, { worktreeId }),
        interpret: preflightDetectAgentsRead.interpret,
        repo
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
