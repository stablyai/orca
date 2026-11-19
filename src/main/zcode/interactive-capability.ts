import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import { extractExecutableToken } from '../../shared/agent-launch/installation/managed-agent-command-token'
import {
  isZCodeMissingTuiOutput,
  type ZCodeInteractiveCapability
} from '../../shared/agent-launch/installation/zcode-missing-tui'
import { resolveCliCommandAsync } from '../../shared/shell/command-resolution/node-cli-command-async-resolution'

/** Probe before opening a pane to avoid racing fast startup failure. version/doctor never load TUI; no-TTY launch distinguishes missing @zcode/tui from loaded UI rejecting a terminal. npm resolves the package, SEA embeds assets, bundled desktop lacks both. */
export type { ZCodeInteractiveCapability }

export type ZCodeInteractiveCapabilityOptions = {
  env?: NodeJS.ProcessEnv
  homePath?: string
  platform?: NodeJS.Platform
  cwd?: string
}

// Measured answers arrive under a second; timeouts mean unknown, never proven missing TUI.
const PROBE_TIMEOUT_MS = 6_000
const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(cmd|bat|exe|com)$/i

const cached = new Map<string, ZCodeInteractiveCapability>()
const inFlight = new Map<string, Promise<ZCodeInteractiveCapability>>()

export function _resetZCodeInteractiveCapabilityForTests(): void {
  cached.clear()
  inFlight.clear()
}

function readPathEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== 'win32') {
    return env.PATH ?? null
  }
  const direct = env.PATH ?? env.Path
  if (direct !== undefined) {
    return direct
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path' && value !== undefined) {
      return value
    }
  }
  return null
}

async function isExistingFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile()
  } catch {
    return false
  }
}

/** Extract the executable from Settings → Agents `agentCmdOverrides.zcode`, defaulting to `zcode`. */
export function resolveZCodeCommandOverride(
  override: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  // PowerShell needs `& "C:\path with spaces\zcode.cmd"` for quoted paths; strip the call operator.
  const input = platform === 'win32' ? override?.trim().replace(/^&\s+/, '') : override
  const token = extractExecutableToken(input, { platform })
  return token && !/[\0\r\n]/.test(token) ? token : 'zcode'
}

function normalizePathEnv(
  pathEnv: string | null,
  cwd: string,
  platform: NodeJS.Platform
): string | null {
  if (!pathEnv) {
    return null
  }
  const pathApi = platform === 'win32' ? win32 : posix
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  // Resolve relative PATH entries like `.` so `path.join('.', name)` cannot collapse a valid hit back to a bare name.
  const entries = pathEnv
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (pathApi.isAbsolute(entry) ? entry : pathApi.resolve(cwd, entry)))
  return entries.length > 0 ? entries.join(pathDelimiter) : null
}

/** Resolve bare names through PATH and standard CLI install dirs so Windows `.cmd` shims keep their extension for process-host's `shell: false` spawn. Returns null when no file exists so missing `.cmd` paths cannot spawn `cmd.exe` and be misclassified as interactive. */
export async function resolveZCodeExecutable(
  command = 'zcode',
  options: ZCodeInteractiveCapabilityOptions = {}
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homePath = options.homePath ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const pathApi = platform === 'win32' ? win32 : posix
  const raw = command.trim() || 'zcode'
  const expanded =
    raw.startsWith('~/') || (platform === 'win32' && raw.startsWith('~\\'))
      ? pathApi.join(homePath, raw.slice(2))
      : raw
  const hasSeparator = expanded.includes('/') || (platform === 'win32' && expanded.includes('\\'))
  if (!hasSeparator) {
    const resolved = await resolveCliCommandAsync(expanded, {
      pathEnv: normalizePathEnv(readPathEnv(env, platform), cwd, platform),
      homePath,
      platform
    })
    return pathApi.isAbsolute(resolved) ? resolved : null
  }
  const target = pathApi.isAbsolute(expanded) ? expanded : pathApi.resolve(cwd, expanded)
  if (platform === 'win32' && !WINDOWS_EXECUTABLE_EXTENSION_RE.test(target)) {
    // Explicit Windows paths without an extension should prefer `.cmd`/`.exe`/`.bat` shims over sibling POSIX scripts (e.g. npm's `zcode` next to `zcode.cmd`).
    for (const extension of ['.cmd', '.exe', '.bat']) {
      const candidate = `${target}${extension}`
      if (await isExistingFile(candidate)) {
        return candidate
      }
    }
  }
  return (await isExistingFile(target)) ? target : null
}

async function probe(
  program: string,
  env?: NodeJS.ProcessEnv
): Promise<ZCodeInteractiveCapability> {
  try {
    const result = await runProcess({
      program,
      args: [],
      ...(env ? { env } : {}),
      // Pipe explicit EOF so capable builds reject missing TTY instead of taking the probe interactive.
      input: '',
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (result.timedOut) {
      return 'unknown'
    }
    return isZCodeMissingTuiOutput(`${result.stderr}\n${result.stdout}`)
      ? 'missing-tui'
      : 'interactive'
  } catch {
    // Spawn failure proves no capability; preserve unknown rather than accuse a healthy CLI.
    return 'unknown'
  }
}

/** Cache definitive capability per resolved executable; transient unknown verdicts may retry. */
export async function readZCodeInteractiveCapability(
  command = 'zcode',
  options: ZCodeInteractiveCapabilityOptions = {}
): Promise<ZCodeInteractiveCapability> {
  const platform = options.platform ?? process.platform
  const program = await resolveZCodeExecutable(command, options)
  if (!program) {
    return 'unknown'
  }
  const cacheKey = platform === 'win32' ? program.toLowerCase() : program
  const existing = cached.get(cacheKey)
  if (existing !== undefined) {
    return existing
  }
  let pending = inFlight.get(cacheKey)
  if (!pending) {
    pending = probe(program, options.env).then((verdict) => {
      // Retry transient unknowns so temporary load cannot suppress the missing-TUI notice for the whole session.
      if (verdict !== 'unknown') {
        cached.set(cacheKey, verdict)
      }
      inFlight.delete(cacheKey)
      return verdict
    })
    inFlight.set(cacheKey, pending)
  }
  return pending
}
