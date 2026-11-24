import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { resolveWorktreeCreateCwdContext } from '../workspace-selection/workspace-selector'
import { getCreateRepoTarget } from './worktree-project-target'
import type { RuntimeWorktreeRecord } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type {
  WorktreeProviderDiagnostic,
  WorktreeProviderWorkspace
} from '../../shared/worktree/provider/worktree-provider-types'

export type ProviderListEntry = {
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

export type ProviderListResult = {
  providers: ProviderListEntry[]
  repoConfigHash?: string
  repoConfigTrusted: boolean
  diagnostics: WorktreeProviderDiagnostic[]
}

export type AcquireResult = {
  worktree: RuntimeWorktreeRecord
  claim: WorktreeProviderWorkspace
  setup: { ran: boolean; source: 'provider' | 'none' }
  catalogVersion?: number
}

export type ReleaseResult = {
  released: true
  forgotten?: true
  provider: string
  warning?: string
  catalogVersion?: number
}

export async function resolveProviderRepo(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  if (!flags.has('repo')) {
    try {
      const context = await resolveWorktreeCreateCwdContext(cwd, client, true, false)
      if (context.repoId) {
        return `id:${context.repoId}`
      }
    } catch (error) {
      if (error instanceof RuntimeClientError) {
        throw error
      }
    }
  }
  return (await getCreateRepoTarget(flags, undefined, client)).repo
}

export async function callProviderList(client: RuntimeClient, repo: string) {
  try {
    return await client.call<ProviderListResult>('worktree.providers.list', { repo })
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      (error.code === 'method_not_found' || error.code === 'unknown_method')
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca host does not support worktree providers. Update Orca on the execution host.'
      )
    }
    throw error
  }
}

export function formatArgv(argv: readonly string[]): string {
  return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ')
}

export function reportDiagnostics(
  diagnostics: readonly WorktreeProviderDiagnostic[],
  json: boolean
): void {
  if (json) {
    return
  }
  for (const diagnostic of diagnostics) {
    const provider = diagnostic.provider ? ` ${diagnostic.provider}` : ''
    console.error(
      `worktree providers: ${diagnostic.source} ${diagnostic.path}${provider}: ${diagnostic.message}`
    )
  }
}
