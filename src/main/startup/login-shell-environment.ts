import { win32 as pathWin32 } from 'node:path'
import { spawnProcess } from '../../shared/child-process/run-process'
import { resolveWindowsShellStartupFamily } from '../../shared/windows-terminal-shell'
import {
  resolveProfileLoadingFallbackShell,
  resolveProfileLoadingShell
} from './hydrate-shell-path'

const START_MARKER = '__ORCA_LOGIN_SHELL_ENV_START__'
const END_MARKER = '__ORCA_LOGIN_SHELL_ENV_END__'
const SPAWN_TIMEOUT_MS = 5000

let cached: Promise<NodeJS.ProcessEnv> | null = null
let cachedShellKey: string | null = null

function processEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function shellProbe(shell: string): string[] | null {
  if (process.platform !== 'win32' || resolveWindowsShellStartupFamily(shell) === 'posix') {
    const command =
      `printf '\\0${START_MARKER}\\0'; /usr/bin/env -0; ` + `printf '\\0${END_MARKER}\\0'`
    return ['-ilc', command]
  }
  const basename = pathWin32.basename(shell).toLowerCase()
  if (basename !== 'powershell.exe' && basename !== 'pwsh.exe') {
    return null
  }
  const command =
    `$values = @{}; [Environment]::GetEnvironmentVariables().GetEnumerator() | ` +
    `ForEach-Object { $values[[string]$_.Key] = [string]$_.Value }; ` +
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
    `[Console]::Write('${START_MARKER}'); ` +
    `[Console]::Write(($values | ConvertTo-Json -Compress)); ` +
    `[Console]::Write('${END_MARKER}')`
  return ['-NoLogo', '-Command', command]
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

function spawnShellAndReadEnvironment(shell: string): Promise<NodeJS.ProcessEnv | null> {
  const args = shellProbe(shell)
  if (!args) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const child = spawnProcess({ program: shell, args, env: process.env })
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
    }, SPAWN_TIMEOUT_MS)
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
        process.platform === 'win32' && resolveWindowsShellStartupFamily(shell) !== 'posix'
          ? parsePowerShellEnvironment(output)
          : parsePosixEnvironment(output)
      )
    })
  })
}

export type ResolveLoginShellEnvironmentOptions = {
  force?: boolean
  shellOverride?: string | null
  spawner?: (shell: string) => Promise<NodeJS.ProcessEnv | null>
}

/** Resolves the environment seen by commands launched from Orca's profile-loading terminal shell. */
export function resolveLoginShellEnvironment(
  options: ResolveLoginShellEnvironmentOptions = {}
): Promise<NodeJS.ProcessEnv> {
  const shell =
    options.shellOverride !== undefined ? options.shellOverride : resolveProfileLoadingShell()
  const fallback = options.shellOverride === undefined ? resolveProfileLoadingFallbackShell() : null
  const shellKey = `${shell ?? ''}\0${fallback ?? ''}`
  if (cached && cachedShellKey === shellKey && !options.force) {
    return cached
  }
  if (!shell) {
    return Promise.resolve(processEnvironment())
  }
  const spawner = options.spawner ?? spawnShellAndReadEnvironment
  cachedShellKey = shellKey
  cached = spawner(shell)
    .then(async (environment) => {
      if (environment) {
        return environment
      }
      return fallback ? ((await spawner(fallback)) ?? processEnvironment()) : processEnvironment()
    })
    .catch(() => processEnvironment())
  return cached
}

export function resetLoginShellEnvironmentCacheForTests(): void {
  cached = null
  cachedShellKey = null
}
