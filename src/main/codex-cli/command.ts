import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

type ResolveCodexCommandOptions = {
  pathEnv?: string | null
  platform?: NodeJS.Platform
  homePath?: string
}

function getExecutableNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return ['codex.cmd', 'codex.exe', 'codex.bat', 'codex']
  }

  return ['codex']
}

function splitPath(pathEnv: string | null | undefined): string[] {
  if (!pathEnv) {
    return []
  }

  return pathEnv
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseVersionSegment(raw: string): number[] {
  return raw
    .replace(/^v/i, '')
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0))
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = parseVersionSegment(left)
  const rightParts = parseVersionSegment(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (delta !== 0) {
      return delta
    }
  }

  return right.localeCompare(left)
}

function findFirstExecutable(directories: string[], executableNames: string[]): string | null {
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }

  return null
}

function getVersionManagerDirectories(
  platform: NodeJS.Platform,
  homePath: string,
  executableNames: string[]
): string[] {
  const directories = [
    join(homePath, '.volta', 'bin'),
    join(homePath, '.asdf', 'shims'),
    join(homePath, '.fnm', 'aliases', 'default', 'bin')
  ]

  // Why: GUI-launched Electron apps do not inherit shell init from version
  // managers like nvm, so `spawn('codex')` can fail for users who installed
  // Codex under a Node-managed bin directory even though Terminal can run it.
  // Probe the newest installed nvm version explicitly so rate-limit tracking
  // and account login use the same Codex binary the shell would expose.
  const nvmVersionsDir = join(homePath, '.nvm', 'versions', 'node')
  if (existsSync(nvmVersionsDir)) {
    const nvmVersionDirectories = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDesc)
      .map((entry) => join(nvmVersionsDir, entry, 'bin'))

    const firstNvmWithCodex = findFirstExecutable(nvmVersionDirectories, executableNames)
    if (firstNvmWithCodex) {
      directories.unshift(dirname(firstNvmWithCodex))
    }
  }

  if (platform === 'win32') {
    directories.push(join(homePath, 'AppData', 'Roaming', 'npm'))
  } else {
    directories.push(join(homePath, '.local', 'bin'))
  }

  return directories
}

export function resolveCodexCommand(options: ResolveCodexCommandOptions = {}): string {
  const platform = options.platform ?? process.platform
  const executableNames = getExecutableNames(platform)
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? null
  const pathCandidate = findFirstExecutable(splitPath(pathEnv), executableNames)
  if (pathCandidate) {
    return pathCandidate
  }

  const homePath = options.homePath ?? homedir()
  const versionManagerCandidate = findFirstExecutable(
    getVersionManagerDirectories(platform, homePath, executableNames),
    executableNames
  )
  return versionManagerCandidate ?? 'codex'
}
