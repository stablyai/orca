import type { RelayPlatform } from './relay-protocol'

export type RemotePathFlavor = 'posix' | 'windows'
export type RemoteCommandDialect = 'posix' | 'powershell'
export type RemoteOperatingSystem = 'linux' | 'darwin' | 'win32'
export type RemoteArchitecture = 'x64' | 'arm64'

export type RemoteHostPlatform = {
  relayPlatform: RelayPlatform
  os: RemoteOperatingSystem
  arch: RemoteArchitecture
  pathFlavor: RemotePathFlavor
  commandDialect: RemoteCommandDialect
  pathSeparator: '/' | '\\'
  pathDelimiter: ':' | ';'
}

const PLATFORM_INFO: Record<RelayPlatform, RemoteHostPlatform> = {
  'linux-x64': {
    relayPlatform: 'linux-x64',
    os: 'linux',
    arch: 'x64',
    pathFlavor: 'posix',
    commandDialect: 'posix',
    pathSeparator: '/',
    pathDelimiter: ':'
  },
  'linux-arm64': {
    relayPlatform: 'linux-arm64',
    os: 'linux',
    arch: 'arm64',
    pathFlavor: 'posix',
    commandDialect: 'posix',
    pathSeparator: '/',
    pathDelimiter: ':'
  },
  'darwin-x64': {
    relayPlatform: 'darwin-x64',
    os: 'darwin',
    arch: 'x64',
    pathFlavor: 'posix',
    commandDialect: 'posix',
    pathSeparator: '/',
    pathDelimiter: ':'
  },
  'darwin-arm64': {
    relayPlatform: 'darwin-arm64',
    os: 'darwin',
    arch: 'arm64',
    pathFlavor: 'posix',
    commandDialect: 'posix',
    pathSeparator: '/',
    pathDelimiter: ':'
  },
  'win32-x64': {
    relayPlatform: 'win32-x64',
    os: 'win32',
    arch: 'x64',
    pathFlavor: 'windows',
    commandDialect: 'powershell',
    pathSeparator: '\\',
    pathDelimiter: ';'
  },
  'win32-arm64': {
    relayPlatform: 'win32-arm64',
    os: 'win32',
    arch: 'arm64',
    pathFlavor: 'windows',
    commandDialect: 'powershell',
    pathSeparator: '\\',
    pathDelimiter: ';'
  }
}

export function getRemoteHostPlatform(platform: RelayPlatform): RemoteHostPlatform {
  return PLATFORM_INFO[platform]
}

export function isWindowsRemoteHost(host: RemoteHostPlatform): boolean {
  return host.os === 'win32'
}

export function normalizeWindowsRemotePath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function normalizeRemoteHome(rawHome: string, host: RemoteHostPlatform): string {
  const home = rawHome.trim()
  return isWindowsRemoteHost(host) ? normalizeWindowsRemotePath(home).replace(/\/+$/, '') : home
}

function hasUnsafeRemotePathChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code === 0 || code === 10 || code === 13) {
      return true
    }
  }
  return false
}

export function validateRemoteHome(home: string, host: RemoteHostPlatform): boolean {
  if (!home || hasUnsafeRemotePathChar(home)) {
    return false
  }
  if (host.pathFlavor === 'windows') {
    return /^[a-zA-Z]:\//.test(home) || home.startsWith('//')
  }
  return home.startsWith('/')
}

export function joinRemotePath(host: RemoteHostPlatform, ...segments: string[]): string {
  const cleaned = segments.filter(Boolean)
  if (cleaned.length === 0) {
    return ''
  }
  if (host.pathFlavor === 'windows') {
    const [first, ...rest] = cleaned.map((segment) => normalizeWindowsRemotePath(segment))
    return rest.reduce((acc, segment) => {
      const left = acc.replace(/\/+$/, '')
      const right = segment.replace(/^\/+/, '')
      return `${left}/${right}`
    }, first)
  }
  const [first, ...rest] = cleaned
  return rest.reduce((acc, segment) => {
    const left = acc.replace(/\/+$/, '')
    const right = segment.replace(/^\/+/, '')
    return `${left}/${right}`
  }, first)
}

export function remoteBasename(path: string, host: RemoteHostPlatform): string {
  const normalized = host.pathFlavor === 'windows' ? normalizeWindowsRemotePath(path) : path
  return normalized.split('/').filter(Boolean).pop() ?? ''
}

export function remoteDirname(path: string, host: RemoteHostPlatform): string {
  const normalized = host.pathFlavor === 'windows' ? normalizeWindowsRemotePath(path) : path
  const parts = normalized.split('/')
  parts.pop()
  const joined = parts.join('/')
  if (host.pathFlavor === 'windows') {
    return joined
  }
  return joined || '/'
}
