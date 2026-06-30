import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { applyShellStartupText } from './shell-path-line-parser'
import {
  sameSegments,
  uniqueSegments,
  type ShellPathParseContext
} from './shell-path-word-expansion'

const MAX_STARTUP_FILE_BYTES = 128 * 1024

type ShellStartupPathOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homePath?: string
}

export type ShellStartupPathResult = {
  segments: string[]
  changed: boolean
}

export function applyShellStartupPathFiles(
  shell: string,
  baseSegments: string[],
  options: ShellStartupPathOptions = {}
): ShellStartupPathResult {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return { segments: baseSegments, changed: false }
  }

  const env = options.env ?? process.env
  const homePath = options.homePath ?? env.HOME ?? homedir()
  const context: ShellPathParseContext = {
    env,
    homePath,
    variables: createInitialVariables(env, homePath)
  }

  let segments = baseSegments
  for (const filePath of getStartupFilePaths(shell, env, homePath)) {
    const content = readBoundedStartupFile(filePath)
    if (content === null) {
      continue
    }
    segments = applyShellStartupText(content, segments, context)
  }

  const normalizedBase = uniqueSegments(baseSegments)
  const normalized = uniqueSegments(segments)
  return { segments: normalized, changed: !sameSegments(normalizedBase, normalized) }
}

function createInitialVariables(env: NodeJS.ProcessEnv, homePath: string): Map<string, string> {
  const variables = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      variables.set(key, value)
    }
  }
  variables.set('HOME', homePath)
  return variables
}

function getStartupFilePaths(shell: string, env: NodeJS.ProcessEnv, homePath: string): string[] {
  const shellName = path.posix.basename(shell).toLowerCase()
  if (shellName === 'zsh') {
    const zDotDir = resolveConfigDirectory(env.ZDOTDIR, homePath) ?? homePath
    return uniqueSegments([
      path.join(zDotDir, '.zshenv'),
      path.join(zDotDir, '.zprofile'),
      path.join(zDotDir, '.zshrc'),
      path.join(zDotDir, '.zlogin')
    ])
  }
  if (shellName === 'bash') {
    return uniqueSegments(
      [
        pickFirstExistingPath([
          path.join(homePath, '.bash_profile'),
          path.join(homePath, '.bash_login'),
          path.join(homePath, '.profile')
        ]),
        path.join(homePath, '.bashrc')
      ].filter((filePath): filePath is string => Boolean(filePath))
    )
  }
  if (shellName === 'fish') {
    const xdgConfig = resolveConfigDirectory(env.XDG_CONFIG_HOME, homePath)
    return [path.join(xdgConfig ?? path.join(homePath, '.config'), 'fish', 'config.fish')]
  }
  return [path.join(homePath, '.profile')]
}

function resolveConfigDirectory(value: string | undefined, homePath: string): string | null {
  if (!value) {
    return null
  }
  if (value === '~') {
    return homePath
  }
  if (value.startsWith('~/')) {
    return path.join(homePath, value.slice(2))
  }
  if (path.isAbsolute(value)) {
    return value
  }
  return path.join(homePath, value)
}

function pickFirstExistingPath(paths: string[]): string | null {
  return paths.find((filePath) => existsSync(filePath)) ?? null
}

function readBoundedStartupFile(filePath: string): string | null {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > MAX_STARTUP_FILE_BYTES) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}
