import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const TAILCAT_INSTALL_HINT =
  'Install the tailcat CLI (brew install tailcat, or a release from github.com/tailscale/tailcat) and try again.'

// Why: a GUI-launched Electron app inherits the login PATH, not the shell PATH, so the package-manager
// and go-install locations must be probed explicitly.
const POSIX_FALLBACK_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = statSync(candidate)
    return stats.isFile() && (platform === 'win32' || (stats.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

export type ResolveTailcatBinaryOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  fallbackDirectories?: readonly string[]
}

/** Locates the tailcat CLI: `ORCA_TAILCAT_PATH`, then PATH, then the usual install directories. */
export function resolveTailcatBinary(options: ResolveTailcatBinaryOptions = {}): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const override = env.ORCA_TAILCAT_PATH?.trim()
  if (override) {
    return isExecutableFile(override, platform) ? override : null
  }
  const name = platform === 'win32' ? 'tailcat.exe' : 'tailcat'
  const pathEntries = (env.PATH ?? env.Path ?? '').split(delimiter).filter((entry) => entry !== '')
  const fallbacks =
    options.fallbackDirectories ??
    (platform === 'win32'
      ? []
      : [...POSIX_FALLBACK_DIRECTORIES, join(home, '.local', 'bin'), join(home, 'go', 'bin')])
  for (const directory of [...pathEntries, ...fallbacks]) {
    const candidate = join(directory, name)
    if (isExecutableFile(candidate, platform)) {
      return candidate
    }
  }
  return null
}

// Why: tailcat's `--key` treats a value as a path only when it contains `/`, which Go also accepts on Windows.
export function tailcatKeyPathArgument(keyPath: string): string {
  return keyPath.split('\\').join('/')
}
