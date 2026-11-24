import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { WorktreeProviderError } from '../../../workspaces/providers/provider-process-runner'
import {
  readWorktreeProviderCatalog,
  type WorktreeProviderCatalog,
  type WorktreeProviderListingEntry
} from '../../../workspaces/providers/provider-config-reader'
import {
  readWorktreeProviderTrustFile,
  writeWorktreeProviderTrustFile
} from '../../../workspaces/providers/provider-trust-store'
import {
  providerTimeoutSeconds,
  providerWorkingDirectory
} from '../../../../shared/worktree/provider/worktree-provider-config'
import { withWorktreeProviderConfigTrusted } from '../../../../shared/worktree/provider/worktree-provider-trust'
import type { ResolvedWorktreeProvider } from '../../../../shared/worktree/provider/worktree-provider-types'
import { RuntimeProvisionedWorkspaceAdoption } from '../creation/runtime-provisioned-workspace-adoption'

export type ManagedWorktreeProviderSummary = {
  name: string
  source: 'user' | 'repo'
  trusted: boolean
  claim: readonly string[]
  release: readonly string[]
  status?: readonly string[]
  setup?: readonly string[]
  timeoutSeconds: number
  workingDirectory: 'repo' | 'worktree'
}

export type ManagedWorktreeProviderListResult = {
  providers: ManagedWorktreeProviderSummary[]
  repoConfigHash?: string
  repoConfigTrusted: boolean
  diagnostics: WorktreeProviderCatalog['diagnostics']
}

function providerSummary(entry: WorktreeProviderListingEntry): ManagedWorktreeProviderSummary {
  const resolved: ResolvedWorktreeProvider = {
    ...entry.config,
    name: entry.name,
    source: entry.source,
    timeoutSeconds: providerTimeoutSeconds(entry.config),
    workingDirectory: providerWorkingDirectory(entry.config),
    configHash: entry.configHash
  }
  return {
    name: resolved.name,
    source: resolved.source,
    trusted: entry.trusted,
    claim: resolved.claim,
    release: resolved.release,
    ...(resolved.status ? { status: resolved.status } : {}),
    ...(resolved.setup ? { setup: resolved.setup } : {}),
    timeoutSeconds: resolved.timeoutSeconds,
    workingDirectory: resolved.workingDirectory
  }
}

export function assertProviderRepoIsLocal(repo: Repo, store: RuntimeStore): void {
  if (
    isFolderRepo(repo) ||
    getRepoRoutingConnectionId(repo) ||
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
  ) {
    throw new WorktreeProviderError(
      'worktree_provider_not_local',
      'Worktree providers run only on the Orca host that owns the repository checkout. This repository is remote or a folder workspace.',
      { repoId: repo.id }
    )
  }
  if (getLocalProjectWorktreeGitOptions(store, repo).wslDistro !== undefined) {
    throw new WorktreeProviderError(
      'worktree_provider_not_local',
      'Worktree providers are not supported for WSL repositories yet.'
    )
  }
}

export abstract class RuntimeWorktreeProviderConfig extends RuntimeProvisionedWorkspaceAdoption {
  async listManagedWorktreeProviders(
    repoSelector: string
  ): Promise<ManagedWorktreeProviderListResult> {
    const store = this.requireStore()
    const repo = await this.resolveRepoSelector(repoSelector)
    assertProviderRepoIsLocal(repo, store)
    const catalog = await readWorktreeProviderCatalog({
      repo,
      trust: await readWorktreeProviderTrustFile()
    })
    return {
      providers: catalog.listing.map(providerSummary),
      ...(catalog.repoConfigHash ? { repoConfigHash: catalog.repoConfigHash } : {}),
      repoConfigTrusted: catalog.repoConfigTrusted,
      diagnostics: catalog.diagnostics
    }
  }

  async trustManagedWorktreeProviders(
    repoSelector: string,
    request: { expectedConfigHash: string }
  ): Promise<{ trusted: true; configHash: string; providers: string[] }> {
    const store = this.requireStore()
    const repo = await this.resolveRepoSelector(repoSelector)
    assertProviderRepoIsLocal(repo, store)
    const trust = await readWorktreeProviderTrustFile()
    const catalog = await readWorktreeProviderCatalog({ repo, trust })
    if (!catalog.repoConfigHash) {
      throw new WorktreeProviderError(
        'worktree_provider_config_missing',
        `Repository ${repo.displayName} has no providers in its orca.yaml.`,
        { repoId: repo.id }
      )
    }
    if (catalog.repoConfigHash !== request.expectedConfigHash) {
      throw new WorktreeProviderError(
        'worktree_provider_config_changed',
        'The repository provider config changed since it was listed. List the providers and review the new commands before trusting them.',
        { repoId: repo.id, currentConfigHash: catalog.repoConfigHash }
      )
    }
    const next = withWorktreeProviderConfigTrusted(trust, repo.id, catalog.repoConfigHash)
    await writeWorktreeProviderTrustFile(next)
    return {
      trusted: true,
      configHash: catalog.repoConfigHash,
      providers: [...catalog.repoProviders.keys()].sort()
    }
  }
}
