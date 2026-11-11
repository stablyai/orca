import {
  isUnresolvedSshHostAlias,
  foldComparableGitHubHost
} from '../../shared/git/remotes/git-remote-host-alias'
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

/** undefined leaves account binding unfiltered. */
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
  // Why every SSH host: a dotted alias such as github.com-work is still a Host entry, and
  // classifyGitHubOwnerRepoFromRemoteUrl already probes the same cached ssh -G for it.
  if (!host || host === 'github.com' || !remoteUrlUsesSshTransport(remoteUrl)) {
    return host
  }
  // Expand SSH aliases in the runtime that runs gh; aliases themselves are not gh login hosts.
  const context: SshConfigResolutionContext = {
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
  // Why raw: the canonical key is lowercased, but OpenSSH matches Host patterns case-sensitively.
  const alias = rawSshTransportHost(remoteUrl) ?? host
  const resolved = await resolveAlias(alias, context).catch(() => null)
  const hostname = resolved?.hostname?.trim().toLowerCase()
  const dottedHost = !isUnresolvedSshHostAlias(host)
  if (!hostname || isUnresolvedSshHostAlias(hostname)) {
    // Why: a dotted host ssh -G cannot expand is still a literal login host (GitHub Enterprise).
    return dottedHost ? host : undefined
  }
  // Why: only github.com's SSH/www aliases fold; gh keys an Enterprise login by its exact host.
  const resolvedHost = foldComparableGitHubHost(hostname) === 'github.com' ? 'github.com' : hostname
  // Why: a dotted Enterprise Host entry may point HostName at another SSH endpoint (an IP or an
  // SSH-only name) while its gh login stays under the remote's host, so only github.com expands it.
  return dottedHost && resolvedHost !== 'github.com' ? host : resolvedHost
}
