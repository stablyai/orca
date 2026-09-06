import {
  MobileWebQuickCommandLaunchPayloadSchema,
  MobileWebQuickCommandLaunchResultSchema,
  MobileWebQuickCommandMutationPayloadSchema,
  MobileWebQuickCommandSnapshotPayloadSchema,
  MobileWebQuickCommandSnapshotResultSchema,
  type MobileWebQuickCommandMutationPayload,
  type MobileWebQuickCommandSnapshotResult
} from '../../../src/shared/mobile-web/session-quick-command-contract'
import {
  flattenTerminalQuickCommand,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand,
  normalizeTerminalQuickCommands,
  parseNormalizedTerminalQuickCommands,
  type TerminalQuickCommandMutation
} from '../../../src/shared/terminal-quick-commands'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import { isFloatingWorkspaceWorktreeId } from '../session/floating-workspace'
import { getRepoIdFromMobileWorktreeId } from '../session/mobile-session-route-helpers'
import { loadMobileNewTabAgentOptions } from '../session/mobile-new-tab-agent-loader'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export async function executeMobileWebSessionQuickCommandOperation(args: {
  operation: string
  payload: unknown
  requestId: string
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<unknown> {
  if (args.operation === 'quickCommands') {
    const payload = MobileWebQuickCommandSnapshotPayloadSchema.parse(args.payload)
    return quickCommandSnapshot(args.client, args.workspaceAuthority, payload.workspaceId)
  }
  if (args.operation === 'quickCommandMutate') {
    const payload = MobileWebQuickCommandMutationPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const commands = await readQuickCommands(args.client)
    const mutation = hostMutation(payload.mutation, commands, hostWorkspaceId, payload.workspaceId)
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    const response = await args.client.sendRequest('settings.updateTerminalQuickCommands', {
      mutation
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return projectQuickCommands(response.result, hostWorkspaceId, payload.workspaceId)
  }
  if (args.operation === 'createQuickCommand') {
    const payload = MobileWebQuickCommandLaunchPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const command = (await readQuickCommands(args.client)).find(
      (candidate) =>
        candidate.id === payload.commandId && commandMatchesWorkspace(candidate, hostWorkspaceId)
    )
    if (!command) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return launchQuickCommand({
      client: args.client,
      command,
      hostWorkspaceId,
      pageWorkspaceId: payload.workspaceId,
      requestId: args.requestId,
      workspaceAuthority: args.workspaceAuthority
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function quickCommandSnapshot(
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority,
  pageWorkspaceId: string
): Promise<MobileWebQuickCommandSnapshotResult> {
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(pageWorkspaceId)
  return projectQuickCommands(
    { terminalQuickCommands: await readQuickCommands(client) },
    hostWorkspaceId,
    pageWorkspaceId
  )
}

async function readQuickCommands(client: RpcClient): Promise<TerminalQuickCommand[]> {
  const response = await client.sendRequest('settings.getTerminalQuickCommands')
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  const commands = parseNormalizedTerminalQuickCommands(
    (response.result as { terminalQuickCommands?: unknown }).terminalQuickCommands
  )
  if (!commands) {
    throw new MobileWebBrokerError('host_error')
  }
  return commands
}

function projectQuickCommands(
  result: unknown,
  hostWorkspaceId: MobileWebHostWorkspaceId,
  pageWorkspaceId: string
): MobileWebQuickCommandSnapshotResult {
  const commands = parseNormalizedTerminalQuickCommands(
    (result as { terminalQuickCommands?: unknown } | null)?.terminalQuickCommands
  )
  if (!commands) {
    throw new MobileWebBrokerError('host_error')
  }
  const repoId = workspaceRepoId(hostWorkspaceId)
  return MobileWebQuickCommandSnapshotResultSchema.parse({
    commands: commands
      .filter((command) => commandMatchesRepo(command, repoId))
      .map((command) => ({
        ...command,
        scope:
          getTerminalQuickCommandScope(command).type === 'repo'
            ? { type: 'repo' as const, repoId: pageWorkspaceId }
            : { type: 'global' as const }
      })),
    totalCount: commands.length,
    repoId: repoId ? pageWorkspaceId : null
  })
}

function hostMutation(
  mutation: MobileWebQuickCommandMutationPayload['mutation'],
  commands: TerminalQuickCommand[],
  hostWorkspaceId: MobileWebHostWorkspaceId,
  pageWorkspaceId: string
): TerminalQuickCommandMutation {
  const repoId = workspaceRepoId(hostWorkspaceId)
  if (mutation.type === 'delete') {
    const command = commands.find((candidate) => candidate.id === mutation.id)
    if (!command || !commandMatchesRepo(command, repoId)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    return mutation
  }
  const existing = commands.find((candidate) => candidate.id === mutation.command.id)
  if (existing && !commandMatchesRepo(existing, repoId)) {
    throw new MobileWebBrokerError('invalid_request')
  }
  const scope =
    mutation.command.scope.type === 'repo'
      ? mutation.command.scope.repoId === pageWorkspaceId && repoId
        ? { type: 'repo' as const, repoId }
        : null
      : { type: 'global' as const }
  if (!scope) {
    throw new MobileWebBrokerError('invalid_request')
  }
  const command = normalizeTerminalQuickCommands([{ ...mutation.command, scope }])[0]
  if (!command) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return { type: 'upsert', command }
}

async function launchQuickCommand(args: {
  client: RpcClient
  command: TerminalQuickCommand
  hostWorkspaceId: MobileWebHostWorkspaceId
  pageWorkspaceId: string
  requestId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
}) {
  const createParams: Record<string, unknown> = {
    worktree: `id:${args.hostWorkspaceId}`,
    activate: true,
    select: true,
    navigation: 'caller',
    clientMutationId: args.requestId
  }
  let initialInput: { text: string; enter: false; successToast: string } | null = null
  if (isTerminalAgentQuickCommand(args.command)) {
    const agentCommand = args.command
    const options = await loadMobileNewTabAgentOptions({
      client: args.client,
      worktreeId: args.hostWorkspaceId
    })
    if (!options.some((option) => option.agent === agentCommand.agent)) {
      throw new MobileWebBrokerError('invalid_request')
    }
    createParams.agent = agentCommand.agent
    createParams.agentPrompt = agentCommand.prompt
  } else if (args.command.appendEnter) {
    createParams.command = flattenTerminalQuickCommand(args.command).command
    createParams.startupCommandDelivery = 'shell-ready'
  } else {
    initialInput = {
      text: args.command.command,
      enter: false,
      successToast: `${args.command.label.trim() || 'Quick command'} inserted`
    }
  }
  args.workspaceAuthority.assertHostWorkspaceBinding(args.pageWorkspaceId, args.hostWorkspaceId)
  const response = await args.client.sendRequest('session.tabs.createTerminal', createParams)
  if (!response.ok || typeof (response.result as { tab?: { id?: unknown } }).tab?.id !== 'string') {
    throw new MobileWebBrokerError('host_error')
  }
  return MobileWebQuickCommandLaunchResultSchema.parse({
    workspaceId: args.pageWorkspaceId,
    tabId: (response.result as { tab: { id: string } }).tab.id,
    created: true,
    initialInput
  })
}

function commandMatchesWorkspace(command: TerminalQuickCommand, hostWorkspaceId: string): boolean {
  return commandMatchesRepo(command, workspaceRepoId(hostWorkspaceId))
}

function commandMatchesRepo(command: TerminalQuickCommand, repoId: string | null): boolean {
  const scope = getTerminalQuickCommandScope(command)
  return scope.type === 'global' || (repoId !== null && scope.repoId === repoId)
}

function workspaceRepoId(workspaceId: string): string | null {
  if (workspaceId.startsWith('folder:') || isFloatingWorkspaceWorktreeId(workspaceId)) {
    return null
  }
  return getRepoIdFromMobileWorktreeId(workspaceId)
}
