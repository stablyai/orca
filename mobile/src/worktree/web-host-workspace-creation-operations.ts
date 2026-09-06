import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { MobileWebBridgeClientError } from '../../../src/mobile-web/src/mobile-web-bridge-client-error'
import type {
  MobileWebCreationSelection,
  MobileWebCreationFromSourcePayload
} from '../../../src/shared/mobile-web/workspace-creation-create-contract'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { MobileComposerCreateSelection } from '../tasks/mobile-composer-source-types'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../tasks/mobile-work-items'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import type {
  CreateBlankWorkspaceOperationArgs,
  CreateWorkspaceFromSourceOperationArgs,
  HostWorkspaceCreationOperations,
  NewWorkspaceRuntimeSettings
} from './host-workspace-creation-operations'

export function webHostWorkspaceCreationOperations(
  client: MobileWebBridgeClient
): HostWorkspaceCreationOperations {
  return {
    async listRepositories() {
      return (await client.workspaceCreation.repositories()).repositories
    },
    readRetiredWorktreeNames: (repoId) => client.workspaceCreation.retiredNames({ repoId }),
    readRuntimeSettings: async () => webRuntimeSettings(await client.workspaceCreation.settings()),
    readTrustedHooks: () => client.workspaceCreation.trustedHooks(),
    isGitLabCliInstalled: () => client.workspaceCreation.gitLabAvailable(),
    isLinearConnected: () => client.workspaceCreation.linearAvailable(),
    readSshState: (repoId) => client.workspaceCreation.sshState({ repoId }),
    connectSsh: (repoId) => client.workspaceCreation.sshConnect({ repoId }),
    detectAgents: (repoId) => client.workspaceCreation.detectAgents({ repoId }),
    readRepoHooks: (repoId) => client.workspaceCreation.repoHooks({ repoId }),
    readRuntimeCapabilities: () => client.workspaceCreation.runtimeCapabilities(),
    listSparsePresets: (repoId) => client.workspaceCreation.sparsePresets({ repoId }),
    saveSparsePreset: (repoId, payload) =>
      client.workspaceCreation.saveSparsePreset({ repoId, ...payload }),
    persistSetupTrust: (args) => client.workspaceCreation.persistTrust(args),
    async searchGitHubItems(repoId, query) {
      try {
        return await client.workspaceCreationSource.searchGitHub(repoId, query)
      } catch (error) {
        if (error instanceof MobileWebBridgeClientError && error.code === 'not_found') {
          throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
        }
        throw error
      }
    },
    searchGitLabItems: (repoId, query, state) =>
      client.workspaceCreationSource.searchGitLab(repoId, query, state),
    searchLinearIssues: (query, linearWorkspaceId) =>
      client.workspaceCreationSource.searchLinear(query, linearWorkspaceId),
    searchBranches: (repoId, query) => client.workspaceCreationSource.searchBranches(repoId, query),
    resolveGitHubRepoSlug: (repoId) => client.workspaceCreationSource.resolveRepoSlug(repoId),
    lookupGitHubItem: (repoId, number) =>
      client.workspaceCreationSource.lookupGitHub(repoId, number),
    lookupGitHubItemByOwnerRepo: (args) => client.workspaceCreationSource.lookupGitHubRepo(args),
    lookupGitLabItemByPath: (args) => client.workspaceCreationSource.lookupGitLab(args),
    resolvePrBase: (args) => client.workspaceCreationSource.resolvePrBase(args),
    resolveMrBase: (args) => client.workspaceCreationSource.resolveMrBase(args),
    createBlankWorkspace: (args) => createBlankWorkspace(client, args),
    createWorkspaceFromSource: (args) => createWorkspaceFromSource(client, args)
  }
}

function webRuntimeSettings(settings: {
  defaultTuiAgent?: string | null
  disabledTuiAgents?: string[]
  visibleTaskProviders?: ('github' | 'gitlab' | 'linear')[]
}): NewWorkspaceRuntimeSettings {
  const defaultTuiAgent = normalizeWorkspaceAgent(settings.defaultTuiAgent)
  return {
    defaultTuiAgent,
    disabledTuiAgents: settings.disabledTuiAgents?.flatMap((agent) => {
      const normalized = normalizeWorkspaceAgent(agent)
      return normalized && normalized !== 'blank' ? [normalized as TuiAgent] : []
    }),
    visibleTaskProviders: settings.visibleTaskProviders
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
