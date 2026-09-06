import type {
  MobileWebAgentHistoryResumePayload,
  MobileWebAgentHistoryResumeResult
} from '../../../src/shared/mobile-web/agent-history-operation-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildMobileAiVaultResumeLaunch,
  createMobileAiVaultResumeMutationRegistry,
  readMobileRuntimeTerminalWindowsShell,
  resolveMobileAiVaultResumePlatform,
  resumeAiVaultSessionInTerminal,
  type MobileAiVaultResumeSettings
} from '../session/ai-vault-resume-launch'
import { readMobileRuntimeHostPlatform } from '../transport/mobile-runtime-host-platform'
import {
  prepareMobileAiVaultSessionResume,
  RESUME_RPC_TIMEOUT_MS
} from '../session/ai-vault-resume-preparation'
import {
  resolveMobileAiVaultSessionResumeTarget,
  type MobileAiVaultResumeFolderWorkspace,
  type MobileAiVaultResumeProjectGroup,
  type MobileAiVaultResumeRepo
} from '../agent-history/agent-history-resume-target'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export class MobileWebAgentHistoryResume {
  private mutationRegistry
  private nextMutation = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {
    this.mutationRegistry = createMobileAiVaultResumeMutationRegistry((sessionId) =>
      this.createMutationId(sessionId)
    )
  }

  async resume(args: {
    payload: MobileWebAgentHistoryResumePayload
    client: RpcClient
    agentHistoryAuthority: MobileWebAgentHistoryAuthority
    workspaceAuthority: MobileWebWorkspaceAuthority
  }): Promise<MobileWebAgentHistoryResumeResult> {
    const session = args.agentHistoryAuthority.hostSession(args.payload.sessionHandle)
    if (!session.sessionId.trim()) {
      return { status: 'blocked', message: 'This session is missing a resume id.' }
    }
    const activeWorktreeId = args.workspaceAuthority.hostWorkspaceId(args.payload.workspaceId)
    try {
      const [metadata, hostStatus] = await Promise.all([
        loadResumeMetadata(args.client),
        requiredResult(args.client, 'status.get')
      ])
      const target = resolveMobileAiVaultSessionResumeTarget({
        session,
        activeWorktreeId,
        worktrees: metadata.worktrees,
        repos: metadata.repos,
        folderWorkspaces: metadata.folderWorkspaces,
        projectGroups: metadata.projectGroups
      })
      if (target.status !== 'ready') {
        return { status: 'blocked', message: target.message }
      }
      const platform = resolveMobileAiVaultResumePlatform(
        target.targetStatus,
        readMobileRuntimeHostPlatform(hostStatus),
        target.workspacePath,
        target.terminalPlatform
      )
      if (!platform) {
        return { status: 'blocked', message: 'Unable to determine host platform.' }
      }
      const preparedSession = await prepareMobileAiVaultSessionResume(args.client, session)
      const launch = buildMobileAiVaultResumeLaunch({
        session: preparedSession,
        hostPlatform: platform,
        hostTerminalWindowsShell: readMobileRuntimeTerminalWindowsShell(hostStatus),
        settings: metadata.settings
      })
      const assertCurrent = () => {
        args.workspaceAuthority.assertHostWorkspaceBinding(
          args.payload.workspaceId,
          activeWorktreeId
        )
        args.agentHistoryAuthority.assertSession(args.payload.sessionHandle, session)
      }
      await resumeAiVaultSessionInTerminal(
        args.client,
        target.worktreeId,
        {
          ...launch,
          clientMutationId: this.mutationRegistry.claim(session.id)
        },
        assertCurrent
      )
      this.mutationRegistry.releaseOnSuccess(session.id)
      const targetWorktree = metadata.worktrees.find(
        (worktree) => worktree.worktreeId === target.worktreeId
      )
      if (!targetWorktree) {
        throw new MobileWebBrokerError('not_found')
      }
      return {
        status: 'queued',
        targetWorkspaceId: args.workspaceAuthority.registerWorkspace(
          targetWorktree.worktreeId,
          targetWorktree.repoId
        ),
        targetWorkspaceName: (targetWorktree.displayName || 'Worktree').slice(0, 240)
      }
    } catch (error) {
      if (error instanceof MobileWebBrokerError) {
        throw error
      }
      throw new MobileWebBrokerError('host_error')
    }
  }

  clear(): void {
    this.nextMutation = 0
    this.mutationRegistry = createMobileAiVaultResumeMutationRegistry((sessionId) =>
      this.createMutationId(sessionId)
    )
  }

  private createMutationId(sessionId: string): string {
    const bytes = this.randomBytes(12)
    if (bytes.byteLength !== 12) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextMutation.toString(36)
    this.nextMutation += 1
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
    return `mobile-web-ai-vault:${safeSession}:${counter}:${Array.from(bytes, byteToHex).join('')}`
  }
}

async function loadResumeMetadata(client: RpcClient): Promise<{
  repos: MobileAiVaultResumeRepo[]
  folderWorkspaces: MobileAiVaultResumeFolderWorkspace[]
  projectGroups: MobileAiVaultResumeProjectGroup[]
  settings: MobileAiVaultResumeSettings | null
  worktrees: Worktree[]
}> {
  const [
    repoResponse,
    folderWorkspaceResponse,
    projectGroupResponse,
    settingsResponse,
    worktreeResponse
  ] = await Promise.all([
    client.sendRequest('repo.list', undefined, { timeoutMs: RESUME_RPC_TIMEOUT_MS }),
    optionalResult(client, 'folderWorkspace.list'),
    optionalResult(client, 'projectGroup.list'),
    optionalResult(client, 'settings.get'),
    requiredResult(client, 'worktree.ps', { limit: 10_000 })
  ])
  if (!repoResponse.ok) {
    throw mobileWebBrokerHostRpcError(repoResponse.error)
  }
  const repoResult = repoResponse.result as { repos?: MobileAiVaultResumeRepo[] }
  const folderWorkspaceResult = folderWorkspaceResponse as {
    folderWorkspaces?: MobileAiVaultResumeFolderWorkspace[]
  } | null
  const projectGroupResult = projectGroupResponse as {
    groups?: MobileAiVaultResumeProjectGroup[]
  } | null
  const settingsResult = settingsResponse as { settings?: MobileAiVaultResumeSettings } | null
  const worktreeResult = worktreeResponse as { worktrees?: Worktree[] }
  if (!Array.isArray(worktreeResult.worktrees)) {
    throw new MobileWebBrokerError('host_error')
  }
  return {
    repos: Array.isArray(repoResult.repos) ? repoResult.repos : [],
    folderWorkspaces: Array.isArray(folderWorkspaceResult?.folderWorkspaces)
      ? folderWorkspaceResult.folderWorkspaces
      : [],
    projectGroups: Array.isArray(projectGroupResult?.groups) ? projectGroupResult.groups : [],
    settings: settingsResult?.settings ?? null,
    worktrees: worktreeResult.worktrees
  }
}

async function requiredResult(
  client: RpcClient,
  method: string,
  params?: unknown
): Promise<unknown> {
  const response = await client.sendRequest(method, params, { timeoutMs: RESUME_RPC_TIMEOUT_MS })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  return response.result
}

async function optionalResult(client: RpcClient, method: string): Promise<unknown | null> {
  try {
    return await requiredResult(client, method)
  } catch {
    return null
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
