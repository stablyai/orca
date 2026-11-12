import { createHash } from 'node:crypto'
import { win32 as pathWin32 } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import {
  isPosixPwshShell,
  POSIX_PWSH_LOGIN_ARG,
  resolvePosixPaneShellPath
} from '../../pty/shell-startup/posix-pwsh'
import {
  resolveProfileLoadingFallbackShell,
  resolveProfileLoadingShell
} from './hydrate-shell-path'
import { shellProbeDetached } from './shell-path-probe'
import { bindShellProbeLifetime } from './shell-probe-lifetime'

const START_MARKER = '__ORCA_LOGIN_SHELL_ENV_START__'
const END_MARKER = '__ORCA_LOGIN_SHELL_ENV_END__'
const SPAWN_TIMEOUT_MS = 5000

export type LoginShellEnvironmentCapture = {
  status: 'captured' | 'fallback'
  env: NodeJS.ProcessEnv
}

type CachedEnvironment = {
  /** The last good result: a fallback stays only until a capture replaces it. */
  last?: LoginShellEnvironmentCapture
  lastStartedAt: number
  /** When the newest finished run started; an older run finishing later is ignored. */
  attemptedAt: number
  running?: { capture: Promise<LoginShellEnvironmentCapture>; startedAt: number }
}

const environmentCache = new Map<string, CachedEnvironment>()
const MAX_CACHED_ENVIRONMENTS = 8
/** Moves whenever a cached capture is replaced or dropped. */
let cacheRevision = 0

/** Lets a reader of the cached capture tell, synchronously, that what it read is still current. */
export function loginShellEnvironmentRevision(): number {
  return cacheRevision
}

function cachedEnvironment(key: string): CachedEnvironment {
  const existing = environmentCache.get(key)
  if (existing) {
    return existing
  }
  while (environmentCache.size >= MAX_CACHED_ENVIRONMENTS) {
    const oldest = environmentCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    environmentCache.delete(oldest)
    cacheRevision++
  }
  const entry: CachedEnvironment = { attemptedAt: -Infinity, lastStartedAt: -Infinity }
  environmentCache.set(key, entry)
  return entry
}

function processEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function powerShellEnvironmentDump(values: string): string {
  return (
    `$values = ${values}; [Environment]::GetEnvironmentVariables().GetEnumerator() | ` +
    `ForEach-Object { $values[[string]$_.Key] = [string]$_.Value }; ` +
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `[Console]::Write('${START_MARKER}'); ` +
    `[Console]::Write(($values | ConvertTo-Json -Compress)); ` +
    `[Console]::Write('${END_MARKER}')`
  )
}

const POWERSHELL_ENVIRONMENT_DUMP = powerShellEnvironmentDump('@{}')
// Unix env names are case-sensitive, and @{} would merge PATH and Path into one key.
const POSIX_POWERSHELL_ENVIRONMENT_DUMP = powerShellEnvironmentDump(
  '[System.Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)'
)

type ShellProbe = { args: string[]; output: 'posix' | 'powershell' }

function shellProbe(shell: string): ShellProbe | null {
  if (process.platform !== 'win32') {
    if (isPosixPwshShell(shell)) {
      // pwsh rejects -ilc.
      return {
        args: [
          POSIX_PWSH_LOGIN_ARG,
          '-NoLogo',
          '-NonInteractive',
          '-Command',
          POSIX_POWERSHELL_ENVIRONMENT_DUMP
        ],
        output: 'powershell'
      }
    }
    const command =
      `printf '\\0${START_MARKER}\\0'; /usr/bin/env -0; ` + `printf '\\0${END_MARKER}\\0'`
    return { args: ['-ilc', command], output: 'posix' }
  }
  if (resolveWindowsShellStartupFamily(shell) === 'posix') {
    // Git Bash's own env holds MSYS paths (/c/..., TEMP=/tmp); a native child sees the converted values native agents get.
    const encoded = Buffer.from(POWERSHELL_ENVIRONMENT_DUMP, 'utf16le').toString('base64')
    return {
      args: [
        '-ilc',
        `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
      ],
      output: 'powershell'
    }
  }
  const basename = pathWin32.basename(shell).toLowerCase()
  if (basename !== 'powershell.exe' && basename !== 'pwsh.exe') {
    return null
  }
  return { args: ['-NoLogo', '-Command', POWERSHELL_ENVIRONMENT_DUMP], output: 'powershell' }
}

function parsePosixEnvironment(output: Buffer): NodeJS.ProcessEnv | null {
  const start = output.indexOf(Buffer.from(`\0${START_MARKER}\0`))
  const end = output.indexOf(Buffer.from(`\0${END_MARKER}\0`), start + START_MARKER.length + 2)
  if (start === -1 || end === -1) {
    return null
  }
  const bodyStart = start + START_MARKER.length + 2
  const entries = output.subarray(bodyStart, end).toString('utf8').split('\0')
  const environment: NodeJS.ProcessEnv = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator > 0) {
      environment[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
  }
  return Object.keys(environment).length > 0 ? environment : null
}

function parsePowerShellEnvironment(output: Buffer): NodeJS.ProcessEnv | null {
  const text = output.toString('utf8')
  const start = text.indexOf(START_MARKER)
  const end = text.indexOf(END_MARKER, start + START_MARKER.length)
  if (start === -1 || end === -1) {
    return null
  }
  try {
    const parsed = JSON.parse(text.slice(start + START_MARKER.length, end)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
    return entries.length > 0 ? Object.fromEntries(entries) : null
  } catch {
    return null
  }
}

async function spawnShellAndReadEnvironment(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = SPAWN_TIMEOUT_MS
): Promise<NodeJS.ProcessEnv | null> {
  const probe = shellProbe(shell)
  if (!probe) {
    return null
  }
  const program = await resolvePosixPaneShellPath(shell, env.PATH ?? '')
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const child = spawnProcess({
      program,
      args: probe.args,
      env,
      detached: shellProbeDetached()
    })
    const lifetime = bindShellProbeLifetime(child)
    const finish = (value: NodeJS.ProcessEnv | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      lifetime.release()
      resolve(value)
    }
    const timer = setTimeout(() => {
      lifetime.kill()
      finish(null)
    }, timeoutMs)
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => finish(null))
    child.stderr.on('error', () => {})
    child.stdin.end()
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => finish(null))
    child.on('close', () => {
      const output = Buffer.concat(chunks)
      finish(
        probe.output === 'powershell'
          ? parsePowerShellEnvironment(output)
          : parsePosixEnvironment(output)
      )
    })
  })
}

export type ResolveLoginShellEnvironmentOptions = {
  /** Reads the last capture or process fallback without starting or awaiting shell work. */
  cachedOnly?: boolean
  /** Only a run that started at or after this time answers, running or finished; one is started if none has. */
  startedAfter?: number
  /** Serves the last result, rerunning the shell in the background once the last run is older. */
  refreshAfterMs?: number
  /** A captured env is kept for good; only a fallback is rerun after `refreshAfterMs`. */
  keepCaptured?: boolean
  shellOverride?: string | null
  env?: NodeJS.ProcessEnv
  /** Per-shell probe budget; defaults to 5 s. */
  timeoutMs?: number
  spawner?: (shell: string, env: NodeJS.ProcessEnv) => Promise<NodeJS.ProcessEnv | null>
}

/** Capture terminal-shell environment or process fallback; cache by shell/environment and let newest-started completed runs win. */
export function captureLoginShellEnvironment(
  options: ResolveLoginShellEnvironmentOptions = {}
): Promise<LoginShellEnvironmentCapture> {
  const shell =
    options.shellOverride !== undefined ? options.shellOverride : resolveProfileLoadingShell()
  const fallback = options.shellOverride === undefined ? resolveProfileLoadingFallbackShell() : null
  const env = processEnvironment(options.env)
  const fellBack: LoginShellEnvironmentCapture = { status: 'fallback', env }
  if (!shell) {
    return Promise.resolve(fellBack)
  }
  const envKey =
    options.env === undefined
      ? ''
      : createHash('sha256')
          .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
          .digest('hex')
  const entry = cachedEnvironment(`${shell}\0${fallback ?? ''}\0${envKey}`)
  const run = (): Promise<LoginShellEnvironmentCapture> => {
    const startedAt = Date.now()
    const spawner =
      options.spawner ??
      ((probeShell: string, probeEnv: NodeJS.ProcessEnv) =>
        spawnShellAndReadEnvironment(probeShell, probeEnv, options.timeoutMs))
    const capture = spawner(shell, env)
      .then(async (environment): Promise<LoginShellEnvironmentCapture> => {
        const captured = environment ?? (fallback ? await spawner(fallback, env) : null)
        return captured ? { status: 'captured', env: captured } : fellBack
      })
      .catch(() => fellBack)
    entry.running = { capture, startedAt }
    void capture.then((result) => {
      if (entry.running?.capture === capture) {
        entry.running = undefined
      }
      if (startedAt < entry.attemptedAt) {
        return
      }
      entry.attemptedAt = startedAt
      if (result.status === 'captured' || entry.last?.status !== 'captured') {
        entry.last = result
        entry.lastStartedAt = startedAt
        cacheRevision++
      }
    })
    return capture
  }
  const { running, last } = entry
  if (options.cachedOnly) {
    return Promise.resolve(last ?? fellBack)
  }
  if (options.startedAfter !== undefined) {
    if (running && running.startedAt >= options.startedAfter) {
      return running.capture
    }
    // Strictly later: a same-millisecond run may predate the request.
    return last && entry.lastStartedAt > options.startedAfter ? Promise.resolve(last) : run()
  }
  if (!last) {
    return running?.capture ?? run()
  }
  const stale =
    options.refreshAfterMs !== undefined &&
    Date.now() - entry.attemptedAt >= options.refreshAfterMs &&
    !(options.keepCaptured && last.status === 'captured')
  if (stale && !running) {
    void run()
  }
  return Promise.resolve(last)
}

export function resolveLoginShellEnvironment(
  options: ResolveLoginShellEnvironmentOptions = {}
): Promise<NodeJS.ProcessEnv> {
  return captureLoginShellEnvironment(options).then((capture) => capture.env)
}

export function resetLoginShellEnvironmentCacheForTests(): void {
  environmentCache.clear()
  cacheRevision++
}
