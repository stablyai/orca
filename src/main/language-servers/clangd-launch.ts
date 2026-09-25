// clangd binary resolution + launch arguments for the native host. S2 scope
// (ticket 12): PATH discovery plus a version gate — no clangd or <12 refuses
// to start, 12-15 suggests an upgrade. Compile databases are only *detected*,
// never generated (S3).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProcessResult } from '../../shared/child-process/process-spec'

export type ClangdLaunchPlan = {
  program: string
  args: string[]
}

/** Dev/testing escape hatch that bypasses PATH discovery. */
export const ORCA_CLANGD_PATH_ENV = 'ORCA_CLANGD_PATH'

/** Minimum clangd major; below this navigation refuses to start (spec D7). */
export const CLANGD_VERSION_GATE_MINIMUM = 12
/** Highest major that still nags the user to upgrade (spec D7: <15 suggests). */
export const CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING = 15

export type ClangdVersionGateKind = 'ok' | 'suggest-upgrade' | 'reject'

export type ClangdVersionGateResult = {
  kind: ClangdVersionGateKind
  major: number | null
  /** Human-facing hint; null on ok, a clear install/upgrade line otherwise. */
  message: string | null
}

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

/**
 * Parses the major version from a `clangd --version` banner, or null when the
 * banner carries no recognizable version. Pure so it stays unit-testable.
 */
export function parseClangdVersion(stdout: string): number | null {
  // clangd prints `clangd version <major>.<minor>.<patch>` (optionally with a
  // trailing git suffix); the first integer after `version` is the major.
  const match = /clangd version\s+(\d+)/i.exec(stdout)
  if (!match) {
    return null
  }
  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) ? major : null
}

/** Gate classification for a resolved major (null = binary missing/bad). */
export function classifyClangdVersion(major: number | null): ClangdVersionGateKind {
  if (major === null || major < CLANGD_VERSION_GATE_MINIMUM) {
    return 'reject'
  }
  if (major <= CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING) {
    return 'suggest-upgrade'
  }
  return 'ok'
}

const CLANGD_VERSION_PROBE_TIMEOUT_MS = 5_000

/**
 * Runs `clangd --version` and returns the gate verdict. Never rejects — a
 * missing binary or a bad banner resolves to a `reject` with an install hint
 * the editor status can surface verbatim (spec D7).
 */
export async function resolveClangdVersionGate(
  program: string,
  runProcessImpl: typeof runProcess = runProcess
): Promise<ClangdVersionGateResult> {
  let result: ProcessResult
  try {
    result = await runProcessImpl({
      program,
      args: ['--version'],
      timeoutMs: CLANGD_VERSION_PROBE_TIMEOUT_MS
    })
  } catch {
    return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
  }
  if (result.timedOut) {
    return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
  }
  const major = parseClangdVersion(result.stdout)
  const kind = classifyClangdVersion(major)
  return { kind, major, message: messageForGate(kind, major) }
}

const CLANGD_INSTALL_HINT =
  "clangd 12+ is required for C/C++ navigation. Install LLVM/Clang tools (e.g. `winget install LLVM.LLVM` on Windows, `brew install llvm` on macOS, or your distro's `clangd` package)."

export { CLANGD_INSTALL_HINT }

function messageForGate(kind: ClangdVersionGateKind, major: number | null): string | null {
  if (kind === 'ok') {
    return null
  }
  if (kind === 'suggest-upgrade') {
    return `clangd ${major} works but navigation is best on clangd ${CLANGD_VERSION_GATE_SUGGEST_UPGRADE_CEILING + 1}+; consider an upgrade.`
  }
  return major === null
    ? CLANGD_INSTALL_HINT
    : `clangd ${major} is below the supported floor of ${CLANGD_VERSION_GATE_MINIMUM}. ${CLANGD_INSTALL_HINT}`
}

export type ClangdLaunchOptions = {
  /** Explicit dir resolved by the compile-db strategy; null means single-file. */
  compileCommandsDir?: string | null
  env?: NodeJS.ProcessEnv
}

/**
 * Build the clangd argv. When `compileCommandsDir` is supplied it is used as-is
 * (the S3 db strategy resolves it); otherwise S1 detection probes for a
 * pre-existing db. Explicit `--compile-commands-dir` beats clangd's ancestor
 * walk, which would latch onto a stray root-level db (spike findings §8).
 */
export function buildClangdLaunch(
  worktreeRoot: string,
  optionsOrEnv: ClangdLaunchOptions | NodeJS.ProcessEnv = {}
): ClangdLaunchPlan {
  const opts = isLaunchOptions(optionsOrEnv) ? optionsOrEnv : { env: optionsOrEnv }
  const env = opts.env ?? process.env
  const compileCommandsDir =
    opts.compileCommandsDir !== undefined
      ? opts.compileCommandsDir
      : detectExistingCompileCommandsDir(worktreeRoot)
  const args: string[] = []
  if (compileCommandsDir) {
    args.push(`--compile-commands-dir=${compileCommandsDir}`)
  }
  args.push('--log=info')
  return { program: resolveClangdProgram(env), args }
}

function isLaunchOptions(
  value: ClangdLaunchOptions | NodeJS.ProcessEnv
): value is ClangdLaunchOptions {
  return typeof value === 'object' && value !== null && 'compileCommandsDir' in value
}
