import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { buildWorktreeProviderReleaseArgv } from '../../../shared/worktree/provider/worktree-provider-command'
import type {
  ResolvedWorktreeProvider,
  WorktreeProviderClaimResponse,
  WorktreeProviderWorkspace
} from '../../../shared/worktree/provider/worktree-provider-types'
import type { GitWorktreeInfo, Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import type { Repo } from '../../../shared/repository/repo-types'
import { WorktreeProviderError, runWorktreeProviderCommand } from './provider-process-runner'
import type { WorktreeProviderCatalog } from './provider-config-reader'

export type ProviderAcquirePorts = {
  getMeta: (worktreeId: string) => WorktreeMeta | undefined
  setMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => void
  listWorktrees: (repoPath: string) => Promise<GitWorktreeInfo[]>
  invalidateScan: (repoId: string) => void
  notifyChanged: (repoId: string) => void
  showWorktree: (selector: string) => Promise<Worktree>
  hasWslDistro: (repo: Repo) => boolean
  runCommand?: typeof runWorktreeProviderCommand
  now?: () => number
}

export function assertLocalProviderExecution(repo: Repo, ports: ProviderAcquirePorts): void {
  if (
    isFolderRepo(repo) ||
    getRepoRoutingConnectionId(repo) ||
    getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
  ) {
    throw new WorktreeProviderError(
      'worktree_provider_not_local',
      'Worktree providers run only on the Orca host that owns the repository checkout. This repository is remote or a folder workspace; run the command on its host.',
      { providerHost: getRepoExecutionHostId(repo) }
    )
  }
  if (ports.hasWslDistro(repo)) {
    throw new WorktreeProviderError(
      'worktree_provider_not_local',
      'Worktree providers are not supported for WSL repositories yet; run Orca inside the distro or use a Linux host.'
    )
  }
}

export function stderrMessage(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed
}

function formatCommand(argv: readonly string[]): string {
  const redacted: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--handle') {
      redacted.push(value, '<redacted>')
      index += 1
      continue
    }
    redacted.push(value)
  }
  return redacted.map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

export async function bestEffortRelease(args: {
  provider: ResolvedWorktreeProvider
  repoPath: string
  response?: Partial<Pick<WorktreeProviderClaimResponse, 'path' | 'leaseId' | 'handle'>>
  ports: ProviderAcquirePorts
}): Promise<{ released: true } | { released: false; message: string }> {
  const { provider, repoPath, response, ports } = args
  if (!response?.path && !response?.leaseId && !response?.handle) {
    return {
      released: false,
      message: 'The claim printed nothing that identifies a lease, so Orca cannot release it.'
    }
  }
  const argv = buildWorktreeProviderReleaseArgv(provider, {
    repoPath,
    ...(response?.path ? { worktreePath: response.path } : {}),
    ...(response?.leaseId ? { leaseId: response.leaseId } : {}),
    ...(response?.handle ? { handle: response.handle } : {}),
    force: false
  })
  const runCommand = ports.runCommand ?? runWorktreeProviderCommand
  try {
    const result = await runCommand({
      argv,
      cwd: repoPath,
      timeoutMs: provider.timeoutSeconds * 1000,
      provider: provider.name,
      phase: 'release'
    })
    if (!result.timedOut && result.code === 0) {
      return { released: true }
    }
    return {
      released: false,
      message: `${result.timedOut ? 'The release command timed out.' : `The release command exited ${result.code ?? 'without a code'}.`} ${stderrMessage(result.stderr)} Run \`${formatCommand(argv)}\` to release it manually.`
    }
  } catch (error) {
    return {
      released: false,
      message: `${error instanceof Error ? error.message : String(error)} Run \`${formatCommand(argv)}\` to release it manually.`
    }
  }
}

export function claimFailure(
  cause: WorktreeProviderError,
  release: Awaited<ReturnType<typeof bestEffortRelease>>
): WorktreeProviderError {
  const suffix = release.released
    ? ' The newly claimed slot was released.'
    : ` The lease is still held. ${release.message}`
  return new WorktreeProviderError(cause.code, `${cause.message}${suffix}`, {
    ...cause.data,
    release
  })
}

export function providerConfigConflict(
  catalog: WorktreeProviderCatalog,
  name: string
): string | undefined {
  return catalog.diagnostics.find(
    (diagnostic) => diagnostic.provider === name && diagnostic.message.includes('defined in both')
  )?.message
}

export function findProvider(
  catalog: WorktreeProviderCatalog,
  name: string
): ResolvedWorktreeProvider {
  const conflict = providerConfigConflict(catalog, name)
  if (conflict) {
    throw new WorktreeProviderError('worktree_provider_config_conflict', conflict, {
      provider: name
    })
  }
  const provider = catalog.providers.get(name)
  if (provider) {
    return provider
  }
  const listed =
    catalog.listing.find((entry) => entry.name === name && entry.source === 'repo') ??
    catalog.listing.find((entry) => entry.name === name)
  if (listed && !listed.trusted) {
    throw new WorktreeProviderError(
      'worktree_provider_untrusted',
      `Provider "${name}" is defined in the repository's orca.yaml but is not trusted on this host. Run \`orca worktree providers trust\` after reviewing its commands.`,
      { provider: name }
    )
  }
  throw new WorktreeProviderError(
    'worktree_provider_not_configured',
    `Unknown worktree provider "${name}". Configure it in ~/.orca/worktree-providers.yaml or a trusted orca.yaml.`,
    { provider: name, knownProviders: catalog.listing.map((entry) => entry.name) }
  )
}

export function existingProviderClaim(
  existing: WorktreeMeta | undefined,
  provider: ResolvedWorktreeProvider,
  response: WorktreeProviderClaimResponse
): WorktreeProviderWorkspace {
  if (
    existing?.worktreeProvider &&
    existing.worktreeProvider.name === provider.name &&
    response.leaseId !== undefined &&
    existing.worktreeProvider.leaseId === response.leaseId
  ) {
    return existing.worktreeProvider
  }
  throw new WorktreeProviderError(
    'worktree_provider_path_conflict',
    existing?.worktreeProvider
      ? `The claimed path is already leased from provider "${existing.worktreeProvider.name}".`
      : 'The claimed path already has an Orca workspace. Release it or choose another slot.',
    { provider: provider.name }
  )
}
