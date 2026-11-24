import { stat } from 'node:fs/promises'
import type { Repo } from '../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { buildWorktreeProviderReleaseArgv } from '../../../shared/worktree/provider/worktree-provider-command'
import type {
  ResolvedWorktreeProvider,
  WorktreeProviderWorkspace
} from '../../../shared/worktree/provider/worktree-provider-types'
import { WorktreeProviderError, runWorktreeProviderCommand } from './provider-process-runner'
import type { WorktreeProviderCatalog } from './provider-config-reader'
import { providerConfigConflict } from './provider-claim-support'

export type ProviderReleasePorts = {
  teardown: (worktreeId: string) => Promise<{ warning?: string }>
  purge: (worktreeId: string) => Promise<void>
  invalidateScan: (repoId: string) => void
  notifyChanged: (repoId: string) => void
  runCommand?: typeof runWorktreeProviderCommand
}

export type ProviderReleaseResult = {
  released: true
  forgotten?: true
  provider: string
  warning?: string
}

function stderrMessage(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function findReleaseProvider(
  catalog: WorktreeProviderCatalog,
  claim: WorktreeProviderWorkspace
): ResolvedWorktreeProvider {
  const conflict = providerConfigConflict(catalog, claim.name)
  if (conflict) {
    throw new WorktreeProviderError('worktree_provider_config_conflict', conflict, {
      provider: claim.name
    })
  }
  const provider = catalog.providers.get(claim.name)
  if (provider) {
    return provider
  }
  const listed = catalog.listing.find((entry) => entry.name === claim.name)
  if (listed && !listed.trusted) {
    throw new WorktreeProviderError(
      'worktree_provider_untrusted',
      `Provider "${claim.name}" is no longer trusted on this host. Restore trust with \`orca worktree providers trust\`, or retry with --forget to unregister without releasing.`,
      { provider: claim.name }
    )
  }
  throw new WorktreeProviderError(
    'worktree_provider_not_configured',
    `Provider "${claim.name}" is not configured on this host. Restore its config, or pass --forget to unregister without releasing the lease.`,
    { provider: claim.name }
  )
}

/** Call the provider's release and unregister the workspace only on success. */
export async function releaseProviderWorktree(args: {
  repo: Repo
  worktreeId: string
  worktreePath: string
  meta: WorktreeMeta
  catalog: WorktreeProviderCatalog
  force: boolean
  forget: boolean
  ports: ProviderReleasePorts
}): Promise<ProviderReleaseResult> {
  const { repo, worktreeId, worktreePath, meta, catalog, force, forget, ports } = args
  const claim = meta.worktreeProvider
  if (!claim) {
    throw new WorktreeProviderError(
      'worktree_provider_not_managed',
      `Workspace ${worktreeId} is not managed by a worktree provider.`,
      { worktreeId }
    )
  }
  if (!forget) {
    const provider = findReleaseProvider(catalog, claim)
    const argv = buildWorktreeProviderReleaseArgv(provider, {
      repoPath: repo.path,
      worktreePath: claim.providerPath ?? worktreePath,
      ...(claim.leaseId ? { leaseId: claim.leaseId } : {}),
      ...(claim.handle ? { handle: claim.handle } : {}),
      force
    })
    const cwd =
      provider.workingDirectory === 'worktree' && (await pathExists(worktreePath))
        ? worktreePath
        : repo.path
    const runCommand = ports.runCommand ?? runWorktreeProviderCommand
    let result: Awaited<ReturnType<typeof runWorktreeProviderCommand>>
    try {
      result = await runCommand({
        argv,
        cwd,
        timeoutMs: provider.timeoutSeconds * 1000,
        provider: provider.name,
        phase: 'release'
      })
    } catch (error) {
      throw error instanceof WorktreeProviderError
        ? error
        : new WorktreeProviderError(
            'worktree_provider_release_failed',
            error instanceof Error ? error.message : String(error),
            { provider: provider.name }
          )
    }
    if (result.timedOut) {
      throw new WorktreeProviderError(
        'worktree_provider_release_failed',
        `Provider "${provider.name}" release timed out after ${provider.timeoutSeconds}s. The workspace was kept.`,
        { provider: provider.name, timedOut: true }
      )
    }
    if (result.code !== 0) {
      throw new WorktreeProviderError(
        'worktree_provider_release_refused',
        `Provider "${provider.name}" refused to release the workspace (exit ${result.code ?? 'unknown'}). ${stderrMessage(result.stderr)} The workspace was kept.`,
        {
          provider: provider.name,
          exitCode: result.code,
          stderr: stderrMessage(result.stderr)
        }
      )
    }
  }

  const teardown = await ports.teardown(worktreeId).catch((error): { warning?: string } => ({
    warning: `The lease was released, but Orca could not stop every process in ${worktreePath}: ${
      error instanceof Error ? error.message : String(error)
    }`
  }))
  await ports.purge(worktreeId)
  ports.invalidateScan(repo.id)
  ports.notifyChanged(repo.id)
  return {
    released: true,
    ...(forget ? { forgotten: true as const } : {}),
    provider: claim.name,
    ...(forget
      ? {
          warning:
            'Unregistered without calling the provider. The lease may still be held; release it with the pool tool if needed.'
        }
      : teardown.warning
        ? { warning: teardown.warning }
        : {})
  }
}
