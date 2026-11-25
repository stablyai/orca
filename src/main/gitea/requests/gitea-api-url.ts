// Self-hosted Gitea often runs on plain HTTP inside a LAN, like the hosted-review client, Jira Server and glab allow.
export function validateGiteaApiUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid Gitea server URL.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Gitea server URLs must use HTTP or HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a Gitea server URL without credentials, query parameters, or fragments.')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * Whether a configured or saved API base belongs to a repo's Git host. A remote that names a port
 * must match it; SSH and default-port remotes carry no port, so the hostname decides.
 */
export function giteaApiBelongsToRepoHost(apiBaseUrl: string, repoHost: string): boolean {
  let api: URL
  try {
    api = new URL(apiBaseUrl)
  } catch {
    return false
  }
  const host = repoHost.toLowerCase()
  return host.includes(':') ? api.host.toLowerCase() === host : api.hostname.toLowerCase() === host
}
