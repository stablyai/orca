// clangd binary resolution + launch arguments for the native host. S1 scope
// (ticket 11): use what already exists — an env override, then PATH/install-dir
// discovery via the shared resolver. Version gates and probing policy are S2
// (ticket 12). Compile databases are only *detected*, never generated (S3).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

export type ClangdLaunchPlan = {
  program: string
  args: string[]
}

/** Dev/testing escape hatch that bypasses PATH discovery. */
export const ORCA_CLANGD_PATH_ENV = 'ORCA_CLANGD_PATH'

/**
 * Build dirs checked for an existing `compile_commands.json`, most generic
 * first. Order matters only for which build wins when several exist.
 */
const COMPILE_COMMANDS_BUILD_DIR_CANDIDATES = [
  'build',
  'build-cc',
  'build-debug',
  'build-release',
  'out',
  'cmake-build-debug',
  'cmake-build-release'
] as const

/**
 * First directory under `worktreeRoot` (or the root itself) that already holds
 * a `compile_commands.json`, or null when nothing pre-exists. Explicit
 * `--compile-commands-dir` beats clangd's own ancestor walk, which would
 * otherwise latch onto a stray root-level db (spike findings §8).
 */
export function detectExistingCompileCommandsDir(worktreeRoot: string): string | null {
  if (existsSync(join(worktreeRoot, 'compile_commands.json'))) {
    return worktreeRoot
  }
  for (const dir of COMPILE_COMMANDS_BUILD_DIR_CANDIDATES) {
    const candidate = join(worktreeRoot, dir)
    if (existsSync(join(candidate, 'compile_commands.json'))) {
      return candidate
    }
  }
  return null
}

export function resolveClangdProgram(
  env: NodeJS.ProcessEnv = process.env,
  options: Parameters<typeof resolveCliCommand>[1] = {}
): string {
  const override = env[ORCA_CLANGD_PATH_ENV]?.trim()
  if (override) {
    return override
  }
  return resolveCliCommand('clangd', options)
}

export function buildClangdLaunch(
  worktreeRoot: string,
  env: NodeJS.ProcessEnv = process.env
): ClangdLaunchPlan {
  const args: string[] = []
  const compileCommandsDir = detectExistingCompileCommandsDir(worktreeRoot)
  if (compileCommandsDir) {
    args.push(`--compile-commands-dir=${compileCommandsDir}`)
  }
  args.push('--log=info')
  return { program: resolveClangdProgram(env), args }
}
