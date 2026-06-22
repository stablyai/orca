import { execFileSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
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
  isRunnableFile?: (candidate: string) => boolean
}

function isRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }
    // Why: Windows has extension-based execution semantics; for jcode.exe,
    // regular-file existence is the portable check Node can rely on here.
    if (platform !== 'win32') {
      accessSync(candidate, constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function pathForPlatform(platform: NodeJS.Platform): PathTools {
  return platform === 'win32' ? path.win32 : path.posix
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
  fileIsRunnable: (candidate: string) => boolean
): string | null {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => pathTools.isAbsolute(line) && fileIsRunnable(line)) ?? null
  )
}

export function resolveJcodeBinForEnvironment({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileSync: runExecFileSync = execFileSync as ExecFileSyncText,
  isRunnableFile: fileIsRunnable = (candidate) => isRunnableFile(candidate, platform)
}: JcodeBinResolutionEnvironment = {}): string {
  const envOverride = env[JCODE_BIN_ENV]?.trim()
  if (envOverride && fileIsRunnable(envOverride)) {
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
        fileIsRunnable
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
  if (fileIsRunnable(cargoCandidate)) {
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
