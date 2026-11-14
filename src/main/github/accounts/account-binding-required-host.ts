import {
  isUnresolvedSshHostAlias,
  foldComparableGitHubHost
} from '../../../shared/git/remotes/git-remote-host-alias'
import { githubHostFromIdentityKey } from '../../../shared/github/repositories/repository-identity-key'
import {
  rawSshTransportHost,
  remoteUrlUsesSshTransport
} from '../repositories/github-remote-identity-parsing'
import {
  resolveSshConfigHostname,
  type SshConfigResolutionContext
} from '../repositories/github-ssh-host-alias-resolution'

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
  // Why: only SSH transport reads ~/.ssh/config; an HTTPS host is literal.
  const remoteUrl = repo.gitRemoteIdentity?.remoteUrl ?? ''
  if (!host || host === 'github.com' || !remoteUrlUsesSshTransport(remoteUrl)) {
    return host
  }
  // Expand SSH aliases in the runtime that runs gh; aliases are not gh login hosts.
  const context: SshConfigResolutionContext = {
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
  // Why raw: the canonical key is lowercased, but OpenSSH matches Host patterns case-sensitively.
  const alias = rawSshTransportHost(remoteUrl) ?? host
  const resolved = await resolveAlias(alias, context).catch(() => null)
  const expanded = resolved?.hostname?.trim().toLowerCase()
  // Why: a dotted host is its own gh login host (a GHE HostName may be an IP) unless it aliases github.com.
  const hostname =
    isUnresolvedSshHostAlias(host) ||
    (expanded && foldComparableGitHubHost(expanded) === 'github.com')
      ? expanded
      : host
  if (!hostname || isUnresolvedSshHostAlias(hostname)) {
    return undefined
  }
  // Why: only github.com's SSH/www aliases fold; gh keys an Enterprise login by its exact host.
  return foldComparableGitHubHost(hostname) === 'github.com' ? 'github.com' : hostname
}
