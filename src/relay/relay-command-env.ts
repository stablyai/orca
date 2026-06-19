const POSIX_RELAY_PATH_FALLBACKS = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin']
const WINDOWS_RELAY_PATH_FALLBACKS = [
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Git\\bin',
  'C:\\Windows\\System32',
  'C:\\Windows'
]

function getPathKey(env: NodeJS.ProcessEnv): 'PATH' | 'Path' {
  return env.Path !== undefined && env.PATH === undefined ? 'Path' : 'PATH'
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function getFallbackSegments(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? WINDOWS_RELAY_PATH_FALLBACKS : POSIX_RELAY_PATH_FALLBACKS
}

export function buildRelayCommandEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const key = getPathKey(baseEnv)
  const delimiter = getPathDelimiter(platform)
  const segments = new Set((baseEnv[key] ?? '').split(delimiter).filter(Boolean))

  for (const segment of getFallbackSegments(platform)) {
    segments.add(segment)
  }

  return {
    ...baseEnv,
    [key]: [...segments].join(delimiter)
  }
}
