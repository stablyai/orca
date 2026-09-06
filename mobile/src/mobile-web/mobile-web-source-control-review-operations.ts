import {
  MobileWebSourceControlReviewDiffPayloadSchema,
  MobileWebSourceControlReviewDiffResultSchema,
  MobileWebSourceControlReviewMetadataPayloadSchema,
  MobileWebSourceControlReviewMetadataUpdatePayloadSchema,
  MobileWebSourceControlReviewLinkPayloadSchema,
  MobileWebSourceControlReviewLinkResultSchema,
  MobileWebSourceControlReviewLinkUpdatePayloadSchema,
  MobileWebSourceControlReviewOpenPayloadSchema,
  MobileWebSourceControlReviewTerminalSendPayloadSchema,
  MobileWebSourceControlReviewTerminalSendResultSchema,
  type MobileWebSourceControlReviewDiffResult,
  type MobileWebSourceControlReviewMetadataResult,
  type MobileWebSourceControlReviewLinkResult,
  type MobileWebSourceControlReviewTerminalSendResult
} from '../../../src/shared/mobile-web/source-control-review-contract'
import type { RpcClient } from '../transport/rpc-client'
import { isMobileGitUnavailable } from '../source-control/mobile-git-status'
import { activateMobileSessionFileTab } from '../session/mobile-session-file-tab-activation'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { sanitizeMobileWebSourceControlDiff } from './mobile-web-source-control-read-results'
import {
  readMobileWebSourceControlReviewMetadata,
  updateMobileWebSourceControlReviewMetadata
} from './mobile-web-source-control-review-metadata'
import { resolveMobileWebTerminal } from './mobile-web-terminal-resolution'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebSourceControlReviewOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
  terminalClientId?: string
}): Promise<
  | MobileWebSourceControlReviewMetadataResult
  | MobileWebSourceControlReviewLinkResult
  | MobileWebSourceControlReviewDiffResult
  | MobileWebSourceControlReviewTerminalSendResult
  | null
> {
  if (args.operation === 'reviewMetadata') {
    const payload = MobileWebSourceControlReviewMetadataPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return readMobileWebSourceControlReviewMetadata({
      client: args.client,
      hostWorkspaceId,
      workspaceId: payload.workspaceId
    })
  }
  if (args.operation === 'reviewLink') {
    const payload = MobileWebSourceControlReviewLinkPayloadSchema.parse(args.payload)
    return readReviewLink(args.client, args.workspaceAuthority, payload.workspaceId)
  }
  if (args.operation === 'reviewLinkUpdate') {
    const payload = MobileWebSourceControlReviewLinkUpdatePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('worktree.set', {
      worktree: `id:${hostWorkspaceId}`,
      ...reviewLinkField(payload.provider, payload.number),
      ...(payload.baseRef ? { baseRef: payload.baseRef } : {})
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    return readReviewLink(args.client, args.workspaceAuthority, payload.workspaceId)
  }
  if (args.operation === 'reviewMetadataUpdate') {
    const payload = MobileWebSourceControlReviewMetadataUpdatePayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return updateMobileWebSourceControlReviewMetadata({
      client: args.client,
      hostWorkspaceId,
      assertCurrent: () =>
        args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId),
      ...payload
    })
  }
  if (args.operation === 'reviewDiff') {
    return executeReviewDiff(args)
  }
  if (args.operation === 'reviewOpen') {
    const payload = MobileWebSourceControlReviewOpenPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const response = await args.client.sendRequest('files.openDiff', {
      worktree: `id:${hostWorkspaceId}`,
      relativePath: payload.relativePath,
      staged: payload.scope === 'staged'
    })
    if (!response.ok) {
      if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
        throw new MobileWebBrokerError('unsupported_capability')
      }
      throw new MobileWebBrokerError('host_error')
    }
    await activateMobileSessionFileTab({
      client: args.client,
      worktreeId: hostWorkspaceId,
      relativePath: payload.relativePath,
      tabMode: 'diff',
      staged: payload.scope === 'staged',
      isCurrent: () => {
        args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
        return true
      }
    })
    return null
  }
  if (args.operation === 'reviewTerminalSend') {
    const payload = MobileWebSourceControlReviewTerminalSendPayloadSchema.parse(args.payload)
    if (!args.terminalClientId) {
      throw new MobileWebBrokerError('invalid_request')
    }
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const terminal = await resolveMobileWebTerminal(args.client, hostWorkspaceId, payload.tabId)
    args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    const response = await args.client.sendRequest('terminal.send', {
      terminal,
      text: payload.text,
      enter: true,
      client: { id: args.terminalClientId, type: 'mobile' }
    })
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    const accepted = terminalSendAccepted(response.result)
    if (accepted === null) {
      throw new MobileWebBrokerError('host_error')
    }
    return MobileWebSourceControlReviewTerminalSendResultSchema.parse({
      accepted
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

export function isMobileWebSourceControlReviewOperation(operation: string): boolean {
  return (
    operation === 'reviewMetadata' ||
    operation === 'reviewMetadataUpdate' ||
    operation === 'reviewLink' ||
    operation === 'reviewLinkUpdate' ||
    operation === 'reviewDiff' ||
    operation === 'reviewOpen' ||
    operation === 'reviewTerminalSend'
  )
}

async function readReviewLink(
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority,
  workspaceId: string
): Promise<MobileWebSourceControlReviewLinkResult> {
  const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(workspaceId)
  const response = await client.sendRequest('worktree.show', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (!response.ok || !isRecord(response.result) || !isRecord(response.result.worktree)) {
    throw new MobileWebBrokerError('host_error')
  }
  const worktree = response.result.worktree
  return MobileWebSourceControlReviewLinkResultSchema.parse({
    workspaceId,
    baseRef: boundedText(worktree.baseRef, 512),
    linkedGitHubPR: positiveInteger(worktree.linkedPR),
    linkedGitLabMR: positiveInteger(worktree.linkedGitLabMR),
    linkedBitbucketPR: positiveInteger(worktree.linkedBitbucketPR),
    linkedAzureDevOpsPR: positiveInteger(worktree.linkedAzureDevOpsPR),
    linkedGiteaPR: positiveInteger(worktree.linkedGiteaPR)
  })
}

function reviewLinkField(provider: string, number: number | null): Record<string, number | null> {
  if (provider === 'github') {
    return { linkedPR: number }
  }
  if (provider === 'gitlab') {
    return { linkedGitLabMR: number }
  }
  if (provider === 'bitbucket') {
    return { linkedBitbucketPR: number }
  }
  if (provider === 'azure-devops') {
    return { linkedAzureDevOpsPR: number }
  }
  return { linkedGiteaPR: number }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function boundedText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null
}

async function executeReviewDiff(
  args: Pick<
    Parameters<typeof executeMobileWebSourceControlReviewOperation>[0],
    'payload' | 'client' | 'workspaceAuthority'
  >
): Promise<MobileWebSourceControlReviewDiffResult> {
  const payload = MobileWebSourceControlReviewDiffPayloadSchema.parse(args.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  const response =
    payload.scope === 'branch'
      ? await args.client.sendRequest('git.branchDiff', {
          worktree: `id:${hostWorkspaceId}`,
          filePath: payload.relativePath,
          ...(payload.oldRelativePath ? { oldPath: payload.oldRelativePath } : {}),
          compare: payload.compare
        })
      : await args.client.sendRequest('git.diff', {
          worktree: `id:${hostWorkspaceId}`,
          filePath: payload.relativePath,
          staged: payload.scope === 'staged'
        })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  const result = sanitizeMobileWebSourceControlDiff(response.result, {
    workspaceId: payload.workspaceId,
    relativePath: payload.relativePath,
    area: payload.scope === 'staged' ? 'staged' : 'unstaged',
    offset: payload.offset,
    limit: payload.limit,
    ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {})
  })
  const { area: _area, ...rest } = result
  return MobileWebSourceControlReviewDiffResultSchema.parse({
    ...rest,
    scope: payload.scope
  })
}

function terminalSendAccepted(value: unknown): boolean | null {
  return isRecord(value) && isRecord(value.send) && typeof value.send.accepted === 'boolean'
    ? value.send.accepted
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
