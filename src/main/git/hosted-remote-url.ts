// Scoped local fork of the hosted-git-info@9.0.3 behavior Orca used.
// Why: source links only need GitHub/GitLab/Bitbucket remote parsing and file
// URL construction, so we keep that small surface local and tested.
type HostedRemoteProvider = 'github' | 'gitlab' | 'bitbucket'

type HostedRemote = {
  host: string
  path: string
  provider: HostedRemoteProvider
}

type HostedRemoteHost = {
  host: string
  provider: HostedRemoteProvider
}

const shorthandHosts: Record<string, { host: string; provider: HostedRemoteProvider }> = {
  bitbucket: { host: 'bitbucket.org', provider: 'bitbucket' },
  github: { host: 'github.com', provider: 'github' },
  gitlab: { host: 'gitlab.com', provider: 'gitlab' }
}

function providerForHost(host: string): HostedRemoteHost | null {
  const normalized = host.toLowerCase()
  if (normalized === 'github.com' || normalized === 'ssh.github.com') {
    // Why: GitHub documents ssh.github.com:443 as the SSH-over-HTTPS host,
    // but browser links and account identity still belong to github.com.
    return { host: 'github.com', provider: 'github' }
  }
  if (normalized === 'gitlab.com') {
    return { host: 'gitlab.com', provider: 'gitlab' }
  }
  if (normalized === 'bitbucket.org') {
    return { host: 'bitbucket.org', provider: 'bitbucket' }
  }
  return null
}

function trimGitSuffix(path: string): string {
  return path.replace(/\.git$/i, '')
}

function decodeRemotePathPart(pathPart: string): string {
  try {
    return decodeURIComponent(pathPart)
  } catch {
    return pathPart
  }
}

function cleanRemotePath(path: string): string | null {
  const normalized = trimGitSuffix(path.replace(/^\/+/, '').replace(/\/+$/, ''))
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length < 2) {
    return null
  }
  return parts.map(decodeRemotePathPart).join('/')
}

export function parseHostedRemote(remoteUrl: string): HostedRemote | null {
  const trimmed = remoteUrl.trim().replace(/^git\+/, '')
  const shorthand = trimmed.match(/^([a-z]+):([^/].+)$/i)
  if (shorthand) {
    const host = shorthandHosts[shorthand[1].toLowerCase()]
    const path = cleanRemotePath(shorthand[2])
    return host && path ? { ...host, path } : null
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+)$/)
    if (scpLike) {
      const hosted = providerForHost(scpLike[1])
      const path = cleanRemotePath(scpLike[2])
      return hosted && path ? { host: hosted.host, path, provider: hosted.provider } : null
    }
  }

  try {
    const url = new URL(trimmed)
    if (!['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const hosted = providerForHost(url.hostname)
    const path = cleanRemotePath(url.pathname)
    return hosted && path ? { host: hosted.host, path, provider: hosted.provider } : null
  } catch {
    return null
  }
}

function encodeRemotePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function encodeRelativePath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function encodeBitbucketFileLineFragment(path: string, line: number): string {
  const fileName = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)
  return fileName ? `#${encodeURIComponent(`${fileName}-${line}`)}` : ''
}

export function buildHostedRemoteFileUrl(
  remoteUrl: string,
  relativePath: string,
  branch: string,
  line: number
): string | null {
  const remote = parseHostedRemote(remoteUrl)
  if (!remote) {
    return null
  }

  const encodedRepoPath = encodeRemotePath(remote.path)
  const encodedBranch = encodeURIComponent(branch)
  const encodedFilePath = encodeRelativePath(relativePath)
  const filePathSuffix = encodedFilePath ? `/${encodedFilePath}` : ''
  const baseUrl = `https://${remote.host}/${encodedRepoPath}`

  if (remote.provider === 'github') {
    return `${baseUrl}/blob/${encodedBranch}${filePathSuffix}#L${line}`
  }
  if (remote.provider === 'gitlab') {
    return `${baseUrl}/-/blob/${encodedBranch}${filePathSuffix}#L${line}`
  }
  return `${baseUrl}/src/${encodedBranch}${filePathSuffix}${encodeBitbucketFileLineFragment(relativePath, line)}`
}

export function buildHostedRemoteCommitUrl(remoteUrl: string, sha: string): string | null {
  const normalizedSha = sha.trim()
  if (!normalizedSha) {
    return null
  }
  const remote = parseHostedRemote(remoteUrl)
  if (!remote) {
    return null
  }

  const baseUrl = `https://${remote.host}/${encodeRemotePath(remote.path)}`
  const encodedSha = encodeURIComponent(normalizedSha)

  if (remote.provider === 'gitlab') {
    return `${baseUrl}/-/commit/${encodedSha}`
  }
  if (remote.provider === 'bitbucket') {
    return `${baseUrl}/commits/${encodedSha}`
  }
  return `${baseUrl}/commit/${encodedSha}`
}
