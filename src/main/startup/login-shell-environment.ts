import { createHash } from 'node:crypto'
import { win32 as pathWin32 } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import {
  resolveProfileLoadingFallbackShell,
  resolveProfileLoadingShell
} from './hydrate-shell-path'

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
  /** When the newest finished run started; an older run finishing later is ignored. */
  attemptedAt: number
  running?: { capture: Promise<LoginShellEnvironmentCapture>; startedAt: number }
}

const environmentCache = new Map<string, CachedEnvironment>()
const MAX_CACHED_ENVIRONMENTS = 8

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
  }
  const entry: CachedEnvironment = { attemptedAt: -Infinity }
  environmentCache.set(key, entry)
  return entry
}

function processEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

const POWERSHELL_ENVIRONMENT_DUMP =
  `$values = @{}; [Environment]::GetEnvironmentVariables().GetEnumerator() | ` +
  `ForEach-Object { $values[[string]$_.Key] = [string]$_.Value }; ` +
  `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
  `[Console]::Write('${START_MARKER}'); ` +
  `[Console]::Write(($values | ConvertTo-Json -Compress)); ` +
  `[Console]::Write('${END_MARKER}')`

function shellProbe(shell: string): string[] | null {
  if (process.platform !== 'win32') {
    const command =
      `printf '\\0${START_MARKER}\\0'; /usr/bin/env -0; ` + `printf '\\0${END_MARKER}\\0'`
    return ['-ilc', command]
  }
  if (resolveWindowsShellStartupFamily(shell) === 'posix') {
    // Git Bash's own env holds MSYS paths (/c/..., TEMP=/tmp); a native child sees the converted values native agents get.
    const encoded = Buffer.from(POWERSHELL_ENVIRONMENT_DUMP, 'utf16le').toString('base64')
    return ['-ilc', `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`]
  }
  const basename = pathWin32.basename(shell).toLowerCase()
  if (basename !== 'powershell.exe' && basename !== 'pwsh.exe') {
    return null
  }
  return ['-NoLogo', '-Command', POWERSHELL_ENVIRONMENT_DUMP]
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

function spawnShellAndReadEnvironment(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = SPAWN_TIMEOUT_MS
): Promise<NodeJS.ProcessEnv | null> {
  const args = shellProbe(shell)
  if (!args) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const child = spawnProcess({ program: shell, args, env })
    const finish = (value: NodeJS.ProcessEnv | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Best-effort timeout cleanup.
      }
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
        process.platform === 'win32'
          ? parsePowerShellEnvironment(output)
          : parsePosixEnvironment(output)
      )
    })
  })
}

export type ResolveLoginShellEnvironmentOptions = {
  /** Reads the last capture or process fallback without starting or awaiting shell work. */
  cachedOnly?: boolean
  /** Only a run that started at or after this time answers; one is started if none has. */
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
      }
    })
    return capture
  }
  const { running, last } = entry
  if (options.cachedOnly) {
    return Promise.resolve(last ?? fellBack)
  }
  if (options.startedAfter !== undefined) {
    return running && running.startedAt >= options.startedAfter ? running.capture : run()
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
}
