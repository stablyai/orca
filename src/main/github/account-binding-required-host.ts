import {
  isUnresolvedSshHostAlias,
  foldComparableGitHubHost
} from '../../shared/git-remote-host-alias'
import { githubHostFromIdentityKey } from '../../shared/github/repository-identity-key'
import { rawSshTransportHost, remoteUrlUsesSshTransport } from './github-remote-identity-parsing'
import {
  resolveSshConfigHostname,
  type SshConfigResolutionContext
} from './github-ssh-host-alias-resolution'

export type SshAliasHostnameResolver = (
  alias: string,
  context: SshConfigResolutionContext
) => Promise<{ hostname: string | null }>

/**
 * Host filter for Settings GitHub account binding.
 * `undefined` means do not filter.
 */
export async function resolveGhAccountRequiredHost(
  repo: {
    path: string
    connectionId?: string | null
    gitRemoteIdentity?: { canonicalKey: string; remoteUrl: string } | null
  },
  localGitOptions: { wslDistro?: string },
  resolveAlias: SshAliasHostnameResolver = resolveSshConfigHostname
): Promise<string | undefined> {
  const host = githubHostFromIdentityKey(repo.gitRemoteIdentity?.canonicalKey)
  // Why: only SSH transport reads ~/.ssh/config; a dotless HTTPS host is literal.
  const remoteUrl = repo.gitRemoteIdentity?.remoteUrl ?? ''
  if (!host || !isUnresolvedSshHostAlias(host) || !remoteUrlUsesSshTransport(remoteUrl)) {
    return host
  }
  // Why: `git@github-personal:owner/repo` keeps the OpenSSH alias in the identity key.
  // No gh login is named after that alias, so filtering to it empties the dropdown.
  // Resolve in the runtime that runs gh (WSL distro vs host) so both see the same ssh config.
  const context: SshConfigResolutionContext = {
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
  // Why raw: the canonical key is lowercased, but OpenSSH matches Host patterns case-sensitively.
  const alias = rawSshTransportHost(remoteUrl) ?? host
  const resolved = await resolveAlias(alias, context).catch(() => null)
  const hostname = resolved?.hostname?.trim().toLowerCase()
  if (!hostname || isUnresolvedSshHostAlias(hostname)) {
    return undefined
  }
  // Why: only github.com's SSH/www aliases fold; gh keys an Enterprise login by its exact host.
  return foldComparableGitHubHost(hostname) === 'github.com' ? 'github.com' : hostname
}
