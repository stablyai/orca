import { gitExecFileAsync } from '../git/runner'

export type AzureDevOpsRepoRef = {
  host: string
  project: string
  repository: string
  apiBaseUrl: string
  webBaseUrl: string
  organization?: string | null
}

const repoRefCache = new Map<string, AzureDevOpsRepoRef | null>()

/** @internal - exposed for tests only */
export function _resetAzureDevOpsRepoRefCache(): void {
  repoRefCache.clear()
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function splitPath(path: string): string[] {
  return path
    .replace(/\.git$/i, '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(decodeSegment)
}

function joinUrl(origin: string, segments: readonly string[]): string {
  const path = segments.map(encodeSegment).join('/')
  return path ? `${origin.replace(/\/+$/, '')}/${path}` : origin.replace(/\/+$/, '')
}

function parseGitHttpPath(
  pathname: string
): { prefix: string[]; project: string; repository: string } | null {
  const parts = splitPath(pathname)
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === '_git')
  if (gitIndex < 1 || gitIndex + 1 >= parts.length) {
    return null
  }
  const project = parts[gitIndex - 1]
  const repository = parts[gitIndex + 1]
  if (!project || !repository) {
    return null
  }
  return {
    prefix: parts.slice(0, gitIndex - 1),
    project,
    repository
  }
}

function makeCloudRef(
  host: string,
  organization: string,
  project: string,
  repository: string
): AzureDevOpsRepoRef {
  return {
    host: host.toLowerCase(),
    organization,
    project,
    repository,
    apiBaseUrl: joinUrl('https://dev.azure.com', [organization, project]),
    webBaseUrl: joinUrl('https://dev.azure.com', [organization, project, '_git', repository])
  }
}

function makeServerRef(
  host: string,
  origin: string,
  prefix: readonly string[],
  project: string,
  repository: string
): AzureDevOpsRepoRef {
  return {
    host: host.toLowerCase(),
    organization: null,
    project,
    repository,
    apiBaseUrl: joinUrl(origin, [...prefix, project]),
    webBaseUrl: joinUrl(origin, [...prefix, project, '_git', repository])
  }
}

function parseDevAzureUrl(url: URL): AzureDevOpsRepoRef | null {
  const parsed = parseGitHttpPath(url.pathname)
  const organization = parsed?.prefix[0]
  if (!parsed || !organization) {
    return null
  }
  return makeCloudRef(url.hostname, organization, parsed.project, parsed.repository)
}

function parseVisualStudioUrl(url: URL): AzureDevOpsRepoRef | null {
  const parsed = parseGitHttpPath(url.pathname)
  const suffix = '.visualstudio.com'
  const host = url.hostname.toLowerCase()
  if (!parsed || !host.endsWith(suffix)) {
    return null
  }
  const organization = host.slice(0, -suffix.length)
  if (!organization) {
    return null
  }
  return {
    host,
    organization,
    project: parsed.project,
    repository: parsed.repository,
    apiBaseUrl: joinUrl(url.origin, [...parsed.prefix, parsed.project]),
    webBaseUrl: joinUrl(url.origin, [...parsed.prefix, parsed.project, '_git', parsed.repository])
  }
}

function parseCloudSshPath(host: string, rawPath: string): AzureDevOpsRepoRef | null {
  if (host.toLowerCase() !== 'ssh.dev.azure.com') {
    return null
  }
  const parts = splitPath(rawPath)
  if (parts.length < 4 || parts[0].toLowerCase() !== 'v3') {
    return null
  }
  const [, organization, project, repository] = parts
  if (!organization || !project || !repository) {
    return null
  }
  return makeCloudRef('dev.azure.com', organization, project, repository)
}

function parseScpLike(remoteUrl: string): AzureDevOpsRepoRef | null {
  const match = remoteUrl.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
  if (!match) {
    return null
  }
  return parseCloudSshPath(match[1], match[2])
}

export function parseAzureDevOpsRepoRef(remoteUrl: string): AzureDevOpsRepoRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return parseScpLike(trimmed)
  }

  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (host === 'ssh.dev.azure.com') {
      return parseCloudSshPath(host, url.pathname)
    }
    if (!['http:', 'https:', 'ssh:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    if (host === 'dev.azure.com') {
      return parseDevAzureUrl(url)
    }
    if (host.endsWith('.visualstudio.com')) {
      return parseVisualStudioUrl(url)
    }

    const parsed = parseGitHttpPath(url.pathname)
    if (!parsed || !['http:', 'https:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    // Why: Azure DevOps Server remotes are self-hosted and only reliably
    // identifiable by the `_git` path convention.
    return makeServerRef(host, url.origin, parsed.prefix, parsed.project, parsed.repository)
  } catch {
    return null
  }
}

export async function getAzureDevOpsRepoRefForRemote(
  repoPath: string,
  remoteName: string
): Promise<AzureDevOpsRepoRef | null> {
  const cacheKey = `${repoPath}\0${remoteName}`
  if (repoRefCache.has(cacheKey)) {
    return repoRefCache.get(cacheKey)!
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
      cwd: repoPath
    })
    const result = parseAzureDevOpsRepoRef(stdout)
    repoRefCache.set(cacheKey, result)
    return result
  } catch {
    repoRefCache.set(cacheKey, null)
    return null
  }
}

export async function getAzureDevOpsRepoRef(repoPath: string): Promise<AzureDevOpsRepoRef | null> {
  return getAzureDevOpsRepoRefForRemote(repoPath, 'origin')
}
