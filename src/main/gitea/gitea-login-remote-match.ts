import type { TeaKnownLogin } from './gitea-known-host-probe'
import type { GiteaRepoRef } from './repository-ref'

type WebEndpoint = {
  protocol: string
  host: string
  hostname: string
  segments: string[]
}

type ParsedRemote =
  | {
      kind: 'http'
      protocol: string
      host: string
      hostname: string
      segments: string[]
    }
  | {
      kind: 'ssh'
      hostname: string
      port: string
      segments: string[]
    }

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function pathSegments(pathname: string): string[] {
  const withoutSuffix = pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  return withoutSuffix
    .split('/')
    .map((part) => decodeSegment(part.trim()))
    .filter(Boolean)
}

function webEndpoint(instanceUrl: string): WebEndpoint | null {
  try {
    const url = new URL(instanceUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/i, '')
    return {
      protocol: url.protocol,
      host: url.host.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      segments: pathSegments(pathname)
    }
  } catch {
    return null
  }
}

function sshEndpoint(sshHost: string): { hostname: string; port: string } {
  const trimmed = sshHost.trim().toLowerCase()
  const slash = trimmed.indexOf('/')
  const hostPort = slash === -1 ? trimmed : trimmed.slice(0, slash)
  const colon = hostPort.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(hostPort.slice(colon + 1))) {
    return { hostname: hostPort.slice(0, colon), port: hostPort.slice(colon + 1) }
  }
  return { hostname: hostPort, port: '' }
}

function parseRemote(remoteUrl: string): ParsedRemote | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (!scpLike?.[1] || !scpLike[2]) {
      return null
    }
    return {
      kind: 'ssh',
      hostname: scpLike[1].toLowerCase(),
      port: '',
      segments: pathSegments(scpLike[2])
    }
  }

  try {
    const url = new URL(trimmed)
    const protocol = url.protocol.toLowerCase()
    if (protocol === 'http:' || protocol === 'https:') {
      return {
        kind: 'http',
        protocol,
        host: url.host.toLowerCase(),
        hostname: url.hostname.toLowerCase(),
        segments: pathSegments(url.pathname)
      }
    }
    if (protocol === 'ssh:' || protocol === 'git+ssh:') {
      return {
        kind: 'ssh',
        hostname: url.hostname.toLowerCase(),
        port: url.port,
        segments: pathSegments(url.pathname)
      }
    }
    return null
  } catch {
    return null
  }
}

function refOnWeb(web: WebEndpoint, segments: string[], loginName: string): GiteaRepoRef | null {
  if (segments.length !== web.segments.length + 2) {
    return null
  }
  for (let index = 0; index < web.segments.length; index += 1) {
    if (segments[index] !== web.segments[index]) {
      return null
    }
  }
  const owner = segments.at(-2) ?? ''
  const repo = segments.at(-1) ?? ''
  if (!owner || !repo) {
    return null
  }
  const webBaseUrl = web.segments.length
    ? `${web.protocol}//${web.host}/${web.segments.join('/')}`
    : `${web.protocol}//${web.host}`
  return {
    host: web.hostname,
    owner,
    repo,
    apiBaseUrl: `${webBaseUrl}/api/v1`,
    webBaseUrl,
    ...(loginName ? { loginName } : {})
  }
}

function sshHostMatches(
  remote: Extract<ParsedRemote, { kind: 'ssh' }>,
  login: TeaKnownLogin,
  web: WebEndpoint
): boolean {
  const ssh = sshEndpoint(login.sshHost || web.host)
  const hostMatches = remote.hostname === ssh.hostname || remote.hostname === web.hostname
  if (!hostMatches) {
    return false
  }
  return !ssh.port || !remote.port || ssh.port === remote.port
}

export function configuredInstanceUrl(): string | null {
  const orca = process.env.ORCA_GITEA_API_BASE_URL?.trim()
  if (orca) {
    return orca
  }
  const tea = process.env.GITEA_INSTANCE_URL?.trim()
  return tea || null
}

export function matchRemoteToGiteaLogin(
  remoteUrl: string,
  login: TeaKnownLogin
): GiteaRepoRef | null {
  const remote = parseRemote(remoteUrl)
  const web = webEndpoint(login.url)
  if (!remote || !web) {
    return null
  }
  if (remote.kind === 'http') {
    if (remote.protocol !== web.protocol || remote.host !== web.host) {
      return null
    }
    return refOnWeb(web, remote.segments, login.name)
  }
  if (!sshHostMatches(remote, login, web)) {
    return null
  }
  return refOnWeb(web, remote.segments, login.name)
}

export function remoteMatchesInstanceUrl(remoteUrl: string, instanceUrl: string): boolean {
  const remote = parseRemote(remoteUrl)
  const env = webEndpoint(instanceUrl)
  if (!remote || !env) {
    return false
  }
  if (remote.kind === 'http') {
    return remote.protocol === env.protocol && remote.host === env.host
  }
  return remote.hostname === env.hostname
}
