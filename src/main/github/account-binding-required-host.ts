import {
  isUnresolvedSshHostAlias,
  foldComparableGitHubHost
} from '../../shared/git-remote-host-alias'
import { githubHostFromIdentityKey } from '../../shared/github/repository-identity-key'
import { gitHubSshConfigHostAlias } from './github-remote-identity-parsing'
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
  // Why: only SSH transport reads ~/.ssh/config; an HTTPS host is literal.
  const alias = host ? gitHubSshConfigHostAlias(repo.gitRemoteIdentity?.remoteUrl ?? '') : null
  if (!host || !alias) {
    return host
  }
  // Expand SSH aliases (dotted too) in the runtime that runs gh; aliases are not gh login hosts.
  const context: SshConfigResolutionContext = {
    repoPath: repo.path,
    connectionId: repo.connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
  const resolved = await resolveAlias(alias, context).catch(() => null)
  const hostname = resolved?.hostname?.trim().toLowerCase()
  if (!hostname) {
    // Why: a dotted host that ssh -G cannot expand is most likely a real Enterprise host.
    return isUnresolvedSshHostAlias(host) ? undefined : host
  }
  if (isUnresolvedSshHostAlias(hostname)) {
    return undefined
  }
  // Why: only github.com's SSH/www aliases fold; gh keys an Enterprise login by its exact host.
  return foldComparableGitHubHost(hostname) === 'github.com' ? 'github.com' : hostname
}
