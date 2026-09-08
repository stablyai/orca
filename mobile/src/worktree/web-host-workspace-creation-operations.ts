import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type {
  MobileWebCreationSelection,
  MobileWebCreationFromSourcePayload
} from '../../../src/shared/mobile-web/workspace-creation-create-contract'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../tasks/mobile-work-items'
import type { MobileComposerCreateSelection } from '../tasks/mobile-composer-source-types'
import type {
  CreateBlankWorkspaceOperationArgs,
  CreateWorkspaceFromSourceOperationArgs,
  HostWorkspaceCreationOperations
} from './host-workspace-creation-operations'
import { rpcWorkspaceCreationOperations } from './rpc-workspace-creation-operations'

export function webHostWorkspaceCreationOperations(
  client: MobileWebBridgeClient
): HostWorkspaceCreationOperations {
  // Every read and lookup is the same desktop request the native app makes, forwarded verbatim.
  const operations = rpcWorkspaceCreationOperations(client.hostRpcSender)
  return {
    ...operations,
    async searchGitHubItems(repoId, query) {
      try {
        return await operations.searchGitHubItems(repoId, query)
      } catch (error) {
        // The bridge collapses a host error to its code, so the host's own wording is gone by the
        // time it reaches here and the SSH-remote guidance has to be restored.
        if (error instanceof Error && error.message === 'not_found') {
          throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
        }
        throw error
      }
    },
    createBlankWorkspace: (args) => createBlankWorkspace(client, args),
    createWorkspaceFromSource: (args) => createWorkspaceFromSource(client, args)
  }
}

async function createBlankWorkspace(
  client: MobileWebBridgeClient,
  args: CreateBlankWorkspaceOperationArgs
) {
  try {
    const result = await client.workspaceCreationCreate.createBlank({
      repoId: args.repoId,
      baseName: args.baseName,
      nameWasGenerated: args.nameWasGenerated,
      agentChoice: args.agentChoice,
      comment: args.comment,
      setupDecision: args.setupDecision
    })
    return { worktreeId: result.workspaceId, name: result.name }
  } catch {
    return { error: 'Unable to create workspace. Try again.' }
  }
}

async function createWorkspaceFromSource(
  client: MobileWebBridgeClient,
  args: CreateWorkspaceFromSourceOperationArgs
) {
  try {
    const payload: MobileWebCreationFromSourcePayload = {
      selection: webCreationSelection(args.selection, args.targetRepoId),
      targetRepoId: args.targetRepoId,
      setupDecision: args.setupDecision,
      agentChoice: args.agentChoice,
      workspaceName: args.workspaceName,
      note: args.note,
      sparseCheckout: args.sparseCheckout,
      nameIsAutoManaged: args.nameIsAutoManaged
    }
    const result = await client.workspaceCreationCreate.createFromSource(payload)
    return {
      worktreeId: result.workspaceId,
      name: result.name,
      ...(result.warning ? { warning: result.warning } : {})
    }
  } catch {
    return { error: 'Unable to create workspace. Try again.' }
  }
}

function webCreationSelection(
  selection: MobileComposerCreateSelection,
  targetRepoId: string
): MobileWebCreationSelection {
  if (selection.kind !== 'work-item') {
    return selection
  }
  const item = selection.item
  if (item.provider === 'linear') {
    return {
      kind: 'work-item',
      item: {
        provider: 'linear',
        type: 'issue',
        number: 0,
        title: item.title,
        url: item.url,
        linearIdentifier: item.linearIdentifier ?? '',
        linearBranchName: item.linearBranchName
      },
      baseBranch: selection.baseBranch,
      branchNameOverride: selection.branchNameOverride
    }
  }
  const linkedItem =
    item.provider === 'github'
      ? {
          provider: 'github' as const,
          type: item.type === 'pr' ? ('pr' as const) : ('issue' as const),
          number: item.number,
          title: item.title,
          url: item.url,
          repoId: item.repoId ?? targetRepoId
        }
      : {
          provider: 'gitlab' as const,
          type: item.type === 'mr' ? ('mr' as const) : ('issue' as const),
          number: item.number,
          title: item.title,
          url: item.url,
          repoId: item.repoId ?? targetRepoId
        }
  return {
    kind: 'work-item',
    item: linkedItem,
    baseBranch: selection.baseBranch,
    compareBaseRef: selection.compareBaseRef,
    pushTarget: selection.pushTarget
      ? {
          remoteName: selection.pushTarget.remoteName,
          branchName: selection.pushTarget.branchName
        }
      : undefined,
    branchNameOverride: selection.branchNameOverride
  }
}
