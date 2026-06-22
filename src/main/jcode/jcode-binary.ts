import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const JCODE_COMMAND = 'jcode'
const JCODE_BIN_ENV = 'ORCA_JCODE_BIN'
const LOGIN_SHELL_TIMEOUT_MS = 5000

let cachedJcodeBin: string | null = null

type ExecFileSyncText = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number }
) => string
type PathTools = typeof path.posix

export type JcodeBinResolutionEnvironment = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  execFileSync?: ExecFileSyncText
  isExistingFile?: (candidate: string) => boolean
}

function isExistingFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function pathForPlatform(platform: NodeJS.Platform): PathTools {
  return platform === 'win32' ? path.win32 : path.posix
}

export function hasJcodeBinEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[JCODE_BIN_ENV]?.trim())
}

function getLoginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const configuredShell = env.SHELL?.trim()
  if (configuredShell) {
    return configuredShell
  }
  if (platform === 'win32') {
    return null
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

function findExistingAbsolutePath(
  output: string,
  pathTools: PathTools,
  fileExists: (candidate: string) => boolean
): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => pathTools.isAbsolute(line) && fileExists(line)) ?? null
  )
}

export function resolveJcodeBinForEnvironment({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileSync: runExecFileSync = execFileSync as ExecFileSyncText,
  isExistingFile: fileExists = isExistingFile
}: JcodeBinResolutionEnvironment = {}): string {
  const envOverride = env[JCODE_BIN_ENV]?.trim()
  if (envOverride && fileExists(envOverride)) {
    return envOverride
  }

  const pathTools = pathForPlatform(platform)
  const loginShell = getLoginShell(env, platform)
  if (loginShell) {
    try {
      const commandPath = findExistingAbsolutePath(
        runExecFileSync(loginShell, ['-lc', 'command -v jcode'], {
          encoding: 'utf8',
          timeout: LOGIN_SHELL_TIMEOUT_MS
        }),
        pathTools,
        fileExists
      )
      if (commandPath) {
        return commandPath
      }
    } catch {
      // Login shell unavailable or jcode not on PATH; fall through to cargo.
    }
  }

  const cargoBinaryName = platform === 'win32' ? 'jcode.exe' : JCODE_COMMAND
  const cargoCandidate = pathTools.join(homeDir, '.cargo', 'bin', cargoBinaryName)
  if (fileExists(cargoCandidate)) {
    return cargoCandidate
  }

  return JCODE_COMMAND
}

/** Resolve once lazily. The final bare name is intentional: it lets spawn surface
 * a clear ENOENT when no configured, shell, or cargo binary exists. */
export function resolveJcodeBin(): string {
  if (cachedJcodeBin) {
    return cachedJcodeBin
  }
  cachedJcodeBin = resolveJcodeBinForEnvironment()
  return cachedJcodeBin
}
