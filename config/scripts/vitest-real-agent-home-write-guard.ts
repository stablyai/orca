import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { userInfo } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach } from 'vitest'

/**
 * Why: agent trust and hook writers resolve `~` at write time, so a unit test that reaches one
 * edits the developer's real Codex, Claude or Orca config. Any write there fails the test instead.
 * Child processes a test spawns are outside this guard.
 */

type GuardState = { roots: string[]; violations: string[] }

const AGENT_HOME_ENTRIES = [
  '.codex',
  '.claude',
  '.orca',
  '.cursor',
  '.copilot',
  '.gemini',
  '.qoder'
]
// Why a bare prefix: Claude's config file and its atomic-write temp siblings sit beside `~/.claude`.
const AGENT_HOME_FILE_PREFIXES = ['.claude.json']
// Why: an Orca terminal exports these pointing at the live app and agent state; guarded, then unset.
const INHERITED_STATE_ENV = [
  'ORCA_USER_DATA_PATH',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'CLAUDE_CONFIG_DIR'
]
// Why: an Orca terminal points this at the live app's CLI, which a test's child shell would run.
const INHERITED_LIVE_CLI_ENV = ['ORCA_CODEX_LAUNCH_PREFLIGHT']
// Why: opted-in real-agent suites point a real CLI at its own home on purpose; each suite's own switch.
const REAL_AGENT_SUITE_SWITCHES = [
  'ORCA_REAL_CLAUDE_SUPERVISED_STOP',
  'ORCA_CODEX_CONTRACT_BINARY',
  'ORCA_CODEX_NO_DAEMON_CONTRACT_BINARY',
  'ORCA_CODEX_TRUST_CONTRACT_BINARY',
  'ORCA_REPRO_CODEX_BINARY'
]
const realAgentSuiteOptedIn = () => REAL_AGENT_SUITE_SWITCHES.some((name) => process.env[name])
const foldCase = process.platform === 'darwin' || process.platform === 'win32'

function normalize(path: string): string {
  const resolved = resolve(path)
  return foldCase ? resolved.toLowerCase() : resolved
}

function realHomes(): string[] {
  const homes = [process.env.HOME, process.env.USERPROFILE]
  try {
    // Why: HOME does not move this one, so a test that swaps HOME cannot hide the real home.
    homes.unshift(userInfo().homedir)
  } catch {
    // No passwd entry (some containers): HOME is all there is.
  }
  return homes.filter((home): home is string => Boolean(home))
}

/** Folder roots end in a separator so `~/.orca` never covers `~/.orca-relay`; file prefixes do not. */
function protectedRoots(): string[] {
  const folders = realHomes().flatMap((home) => [
    ...AGENT_HOME_ENTRIES.map((entry) => join(home, entry)),
    join(home, 'Library', 'Application Support', 'orca'),
    join(home, '.config', 'orca'),
    join(home, 'AppData', 'Roaming', 'orca')
  ])
  for (const name of INHERITED_STATE_ENV) {
    const value = process.env[name]
    if (value && isAbsolute(value)) {
      folders.push(value)
    }
  }
  const filePrefixes = realHomes().flatMap((home) =>
    AGENT_HOME_FILE_PREFIXES.map((entry) => normalize(join(home, entry)))
  )
  return [...new Set([...folders.map((folder) => normalize(folder) + sep), ...filePrefixes])]
}

function targetPath(target: unknown): string | null {
  if (typeof target === 'string') {
    return target.startsWith('file:') ? fileURLToPath(target) : target
  }
  if (target instanceof URL) {
    return fileURLToPath(target)
  }
  if (Buffer.isBuffer(target)) {
    return target.toString()
  }
  return null
}

function assertOutsideRealHome(state: GuardState, operation: string, target: unknown): void {
  const path = targetPath(target)
  if (path === null || realAgentSuiteOptedIn()) {
    return
  }
  const normalized = normalize(path) + sep
  const root = state.roots.find((candidate) => normalized.startsWith(candidate))
  if (!root) {
    return
  }
  const error = new Error(
    `[vitest real-agent-home guard] ${operation}(${path}) would write the real agent home under ${root}; give the test a temp home`
  )
  // Why the stack: the writer that swallowed this is what the failing test has to fix.
  state.violations.push(error.stack?.split('\n').slice(0, 12).join('\n') ?? error.message)
  throw error
}

const WRITE_OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT

function opensForWrite(flags: unknown): boolean {
  if (typeof flags === 'number') {
    return (flags & WRITE_OPEN_FLAGS) !== 0
  }
  return typeof flags === 'string' && /[wa+]/.test(flags)
}

// Argument positions each mutating call writes to; `open` counts only when its flags write.
const GUARDED_TARGETS: Record<string, readonly number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  mkdtemp: [0],
  rename: [0, 1],
  copyFile: [1],
  cp: [1],
  symlink: [1],
  link: [1],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  truncate: [0],
  open: [0]
}

function guard(
  state: GuardState,
  api: typeof fs | typeof fs.promises,
  name: string,
  positions: readonly number[],
  label: string
): void {
  const descriptor = Object.getOwnPropertyDescriptor(api, name)
  const original: unknown = descriptor?.value
  if (!descriptor || typeof original !== 'function') {
    return
  }
  const target = original
  function guarded(this: unknown, ...args: unknown[]): unknown {
    try {
      if (!name.startsWith('open') || opensForWrite(args[1] ?? 'r')) {
        for (const position of positions) {
          assertOutsideRealHome(state, label, args[position])
        }
      }
    } catch (error) {
      if (api === fs.promises) {
        return Promise.reject(error)
      }
      throw error
    }
    return target.apply(this, args)
  }
  Object.defineProperty(api, name, { ...descriptor, value: guarded })
}

function install(): GuardState {
  const state: GuardState = { roots: protectedRoots(), violations: [] }
  for (const [name, positions] of Object.entries(GUARDED_TARGETS)) {
    guard(state, fs, name, positions, `fs.${name}`)
    guard(state, fs, `${name}Sync`, positions, `fs.${name}Sync`)
    guard(state, fs.promises, name, positions, `fs.promises.${name}`)
  }
  guard(state, fs, 'createWriteStream', [0], 'fs.createWriteStream')
  // Why: named ESM imports of node:fs keep the originals until the builtin exports are re-synced.
  syncBuiltinESMExports()
  return state
}

declare global {
  // Why once per process: re-wrapping per test file would stack wrappers around wrappers.
  var orcaRealAgentHomeWriteGuard: GuardState | undefined
}
const state = (globalThis.orcaRealAgentHomeWriteGuard ??= install())
// Why after install: the guard keeps the inherited paths as roots; tests that need one set their own.
export function clearInheritedAgentStateEnv(): void {
  const inheritedEnvToUnset = realAgentSuiteOptedIn()
    ? []
    : [...INHERITED_STATE_ENV, ...INHERITED_LIVE_CLI_ENV]
  for (const name of inheritedEnvToUnset) {
    if (name === 'CLAUDE_CONFIG_DIR' && process.env.ORCA_REAL_CLAUDE_CLI_TEST === '1') {
      continue
    }
    delete process.env[name]
  }
}
clearInheritedAgentStateEnv()

/** Drains recorded violations; only the guard's own self-test should need this. */
export function takeRealAgentHomeWriteViolations(): string[] {
  return state.violations.splice(0)
}

function failOnViolations(): void {
  const violations = takeRealAgentHomeWriteViolations()
  if (violations.length > 0) {
    // Why rethrow here: trust writers swallow errors, so the throw at the call site can vanish.
    throw new Error(`[vitest real-agent-home guard]\n${violations.join('\n')}`)
  }
}

afterEach(failOnViolations)
afterAll(failOnViolations)
