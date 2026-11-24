import { join } from 'node:path'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import type { Repo } from '../../../shared/repository/repo-types'
import { MAX_ORCA_YAML_BYTES } from '../../../shared/workspace-setup/orca-yaml-file-limit'
import {
  parseWorktreeProviders,
  providerTimeoutSeconds,
  providerWorkingDirectory,
  worktreeProviderConfigHash,
  worktreeProviderNameConflicts
} from '../../../shared/worktree/provider/worktree-provider-config'
import {
  isWorktreeProviderConfigTrusted,
  type WorktreeProviderTrustFile
} from '../../../shared/worktree/provider/worktree-provider-trust'
import type {
  ResolvedWorktreeProvider,
  WorktreeProviderConfig,
  WorktreeProviderDiagnostic,
  WorktreeProviderSource
} from '../../../shared/worktree/provider/worktree-provider-types'
import { getUserWorktreeProvidersPath } from './provider-trust-store'

export type WorktreeProviderListingEntry = {
  name: string
  source: WorktreeProviderSource
  trusted: boolean
  config: WorktreeProviderConfig
  configHash: string
}

export type WorktreeProviderCatalog = {
  /** Providers this host may execute for the repo. */
  providers: Map<string, ResolvedWorktreeProvider>
  /** Every declared provider, including untrusted repo entries, for listing/trust UX. */
  listing: WorktreeProviderListingEntry[]
  repoProviders: Map<string, WorktreeProviderConfig>
  repoConfigHash?: string
  repoConfigTrusted: boolean
  diagnostics: WorktreeProviderDiagnostic[]
}

async function readBoundedText(
  path: string
): Promise<{ text?: string; missing?: boolean; tooLarge?: boolean; error?: string }> {
  try {
    const { buffer } = await readNodeFileWithinLimit(path, MAX_ORCA_YAML_BYTES, {
      regularFileOnly: true
    })
    return { text: buffer.toString('utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { missing: true }
    }
    if (error instanceof Error && error.name === 'NodeFileReadTooLargeError') {
      return { tooLarge: true }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function resolveProvider(
  name: string,
  config: WorktreeProviderConfig,
  source: WorktreeProviderSource
): ResolvedWorktreeProvider {
  return {
    ...config,
    name,
    source,
    timeoutSeconds: providerTimeoutSeconds(config),
    workingDirectory: providerWorkingDirectory(config),
    configHash: worktreeProviderConfigHash(new Map([[name, config]]))
  }
}

/** Read user + repo provider config without executing anything. */
export async function readWorktreeProviderCatalog(args: {
  repo: Repo
  trust: WorktreeProviderTrustFile
  userConfigPath?: string
  repoOrcaYamlPath?: string
}): Promise<WorktreeProviderCatalog> {
  const diagnostics: WorktreeProviderDiagnostic[] = []
  const userConfigPath = args.userConfigPath ?? getUserWorktreeProvidersPath()
  const userFile = await readBoundedText(userConfigPath)
  if (userFile.tooLarge) {
    diagnostics.push({
      source: 'user',
      path: userConfigPath,
      message: 'Provider config is larger than the allowed limit.'
    })
  } else if (userFile.error) {
    diagnostics.push({ source: 'user', path: userConfigPath, message: userFile.error })
  }
  const userParsed =
    userFile.text !== undefined
      ? parseWorktreeProviders(userFile.text, 'user', userConfigPath)
      : { providers: new Map<string, WorktreeProviderConfig>(), diagnostics: [] }
  diagnostics.push(...userParsed.diagnostics)

  const repoOrcaYamlPath = args.repoOrcaYamlPath ?? join(args.repo.path, 'orca.yaml')
  const repoFile = await readBoundedText(repoOrcaYamlPath)
  if (repoFile.tooLarge) {
    diagnostics.push({
      source: 'repo',
      path: repoOrcaYamlPath,
      message: 'orca.yaml is larger than the allowed limit.'
    })
  } else if (repoFile.error) {
    diagnostics.push({ source: 'repo', path: repoOrcaYamlPath, message: repoFile.error })
  }
  const repoParsed =
    repoFile.text !== undefined
      ? parseWorktreeProviders(repoFile.text, 'repo', repoOrcaYamlPath)
      : { providers: new Map<string, WorktreeProviderConfig>(), diagnostics: [] }
  diagnostics.push(...repoParsed.diagnostics)

  const repoConfigHash =
    repoParsed.providers.size > 0 ? worktreeProviderConfigHash(repoParsed.providers) : undefined
  const repoConfigTrusted =
    repoConfigHash !== undefined
      ? isWorktreeProviderConfigTrusted(args.trust, args.repo.id, repoConfigHash)
      : false

  const conflicts = worktreeProviderNameConflicts(userParsed.providers, repoParsed.providers)
  for (const name of conflicts) {
    diagnostics.push({
      source: 'repo',
      path: repoOrcaYamlPath,
      provider: name,
      message: `Provider "${name}" is defined in both user config and orca.yaml; remove one.`
    })
  }

  const listing: WorktreeProviderListingEntry[] = []
  for (const [name, config] of userParsed.providers) {
    listing.push({
      name,
      source: 'user',
      trusted: true,
      config,
      configHash: worktreeProviderConfigHash(new Map([[name, config]]))
    })
  }
  for (const [name, config] of repoParsed.providers) {
    listing.push({
      name,
      source: 'repo',
      trusted: repoConfigTrusted,
      config,
      configHash: worktreeProviderConfigHash(new Map([[name, config]]))
    })
  }
  listing.sort((left, right) => left.name.localeCompare(right.name))

  const providers = new Map<string, ResolvedWorktreeProvider>()
  for (const [name, config] of userParsed.providers) {
    if (!conflicts.includes(name)) {
      providers.set(name, resolveProvider(name, config, 'user'))
    }
  }
  if (repoConfigTrusted) {
    for (const [name, config] of repoParsed.providers) {
      if (!conflicts.includes(name)) {
        providers.set(name, resolveProvider(name, config, 'repo'))
      }
    }
  }

  return {
    providers,
    listing,
    repoProviders: new Map(repoParsed.providers),
    ...(repoConfigHash ? { repoConfigHash } : {}),
    repoConfigTrusted,
    diagnostics
  }
}

export function providerDiagnosticsMessage(diagnostics: WorktreeProviderDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const provider = diagnostic.provider ? ` ${diagnostic.provider}` : ''
      return `${diagnostic.source} ${diagnostic.path}${provider}: ${diagnostic.message}`
    })
    .join('\n')
}
