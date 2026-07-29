import { gitLabHostFromUrl } from '../../shared/gitlab-instance-url'

export type LocalGitExecOptions = {
  wslDistro?: string
}

let configuredGitLabHost = ''

export function setConfiguredGitLabUrl(value: unknown): void {
  configuredGitLabHost = gitLabHostFromUrl(value)
}

/** The configured instance host (`host[:port]`), or '' when GitLab is off. */
export function getConfiguredGitLabHost(): string {
  return configuredGitLabHost
}

/**
 * The configured GitLab instance, as a single-entry host list, or empty when
 * GitLab is unconfigured. Async and per-host parameters are retained because
 * callers resolve remotes per execution host; the configured instance is
 * global, so neither affects the result.
 */
export async function getGlabKnownHosts(
  _connectionId?: string | null,
  _localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  return configuredGitLabHost ? [configuredGitLabHost] : []
}

export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set<string>()
  // Why: self-hosted GitLab can run on a non-default port; preserve it so
  // services on the same hostname remain distinct downstream.
  for (const match of output.matchAll(/logged in to ([a-zA-Z0-9.-]+(?::\d+)?)/gi)) {
    hosts.add(match[1].toLowerCase())
  }
  for (const line of output.split('\n')) {
    const bareLine = line.trim()
    const hostLine = bareLine.endsWith(':') ? bareLine.slice(0, -1) : bareLine
    if (
      line === bareLine &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?$/.test(hostLine)
    ) {
      hosts.add(hostLine.toLowerCase())
    }
  }
  return Array.from(hosts)
}
