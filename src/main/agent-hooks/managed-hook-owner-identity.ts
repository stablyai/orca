import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'

const runtimeHostIdentity = `runtime:${randomUUID()}`
const runtimeProcessIdentity = `runtime:${randomUUID()}`
let hostIdentityPromise: Promise<string> | undefined
let bootIdentityPromise: Promise<string | undefined> | undefined
let selfProcessIdentityPromise: Promise<string | null | undefined> | undefined
const HOST_TOKEN_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 5_000

function getWindowsPowerShellPath(): string {
  return win32.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function getWindowsRegistryPath(): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function parseLinuxStartTicks(statLine: string): string | null {
  const commandEnd = statLine.lastIndexOf(')')
  if (commandEnd < 0) {
    return null
  }
  // Field 22 is index 19 after removing pid and the parenthesized command.
  const startTicks = statLine
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19]
  return startTicks ?? null
}

async function readLinuxPidNamespace(pid: number): Promise<string | undefined> {
  try {
    const namespace = await readlink(`/proc/${pid}/ns/pid`)
    return namespace.trim() || undefined
  } catch {
    return undefined
  }
}

async function readPublishedHostToken(path: string, uid: number): Promise<string | undefined> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.uid !== uid || (stats.mode & 0o077) !== 0) {
      return undefined
    }
    const token = (await readFile(path, 'utf8')).trim()
    return HOST_TOKEN_PATTERN.test(token) ? token : undefined
  } catch {
    return undefined
  }
}

async function readDurableHostToken(): Promise<string | undefined> {
  const uid = process.getuid?.()
  if ((process.platform !== 'linux' && process.platform !== 'darwin') || uid === undefined) {
    return undefined
  }
  const directory = join('/var', 'tmp', `orca-managed-hooks-${uid}`)
  const tokenPath = join(directory, 'host-id')
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const directoryStats = await lstat(directory)
    if (
      !directoryStats.isDirectory() ||
      directoryStats.uid !== uid ||
      (directoryStats.mode & 0o077) !== 0
    ) {
      return undefined
    }
    const existing = await readPublishedHostToken(tokenPath, uid)
    if (existing) {
      return existing
    }
    const token = randomUUID()
    const draftPath = join(directory, `host-id-draft-${token}`)
    await writeFile(draftPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      // Why: the hard link publishes a complete token atomically across relay processes.
      await link(draftPath, tokenPath).catch((error) => {
        if (!hasCode(error, 'EEXIST')) {
          throw error
        }
      })
    } finally {
      await unlink(draftPath).catch(() => {})
    }
    return await readPublishedHostToken(tokenPath, uid)
  } catch {
    return undefined
  }
}

async function readHostIdentity(): Promise<string> {
  const durableToken = await readDurableHostToken()
  if (durableToken) {
    return `host-token:${durableToken}`
  }
  if (process.platform === 'linux') {
    // Why: an unverifiable host scope may acquire and release its own clean lock,
    // but a later process gets a different identity and cannot steal its residue.
    return runtimeHostIdentity
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)(
        getWindowsRegistryPath(),
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 1_000, windowsHide: true }
      )
      const machineGuid = /^\s*MachineGuid\s+REG_\w+\s+(.+?)\s*$/im.exec(stdout)?.[1]
      return machineGuid ? `win32:${machineGuid.toLowerCase()}` : runtimeHostIdentity
    } catch {
      return runtimeHostIdentity
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)(
        'ioreg',
        ['-rd1', '-c', 'IOPlatformExpertDevice'],
        {
          encoding: 'utf8',
          timeout: 1_000
        }
      )
      const platformId = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1]
      return platformId ? `darwin:${platformId}` : runtimeHostIdentity
    } catch {
      return runtimeHostIdentity
    }
  }
  return runtimeHostIdentity
}

export async function readBootIdentity(): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      return bootId || undefined
    } catch {
      return undefined
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 1_000
      })
      const bootSessionId = stdout.trim()
      return bootSessionId || undefined
    } catch {
      return undefined
    }
  }

  return undefined
}

export async function readManagedHookHostIdentity(): Promise<string> {
  hostIdentityPromise ??= readHostIdentity()
  return await hostIdentityPromise
}

/** Bind a stable SSH identity to one execution runtime before comparing its PIDs. */
export function scopeManagedHookHostIdentity(
  executionIdentity: string,
  hostKeyFingerprint?: string
): string {
  return hostKeyFingerprint
    ? `ssh-host-key:${hostKeyFingerprint}:execution:${executionIdentity}`
    : executionIdentity
}

/** null means confirmed missing; undefined means the platform probe was unavailable. */
export async function readManagedHookProcessIdentity(
  pid: number
): Promise<string | null | undefined> {
  if (process.platform === 'win32' && pid === process.pid) {
    selfProcessIdentityPromise ??= readProcessIdentity(pid)
    return await selfProcessIdentityPromise
  }
  return await readProcessIdentity(pid)
}

async function readProcessIdentity(pid: number): Promise<string | null | undefined> {
  if (process.platform === 'linux') {
    try {
      const [statLine, pidNamespace, bootIdentity] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readLinuxPidNamespace(pid),
        (bootIdentityPromise ??= readBootIdentity())
      ])
      const startTicks = parseLinuxStartTicks(statLine)
      return startTicks
        ? `linux:${pidNamespace ?? 'unknown-namespace'}:${bootIdentity ?? 'unknown-boot'}:${startTicks}`
        : undefined
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return null
      }
      return pid === process.pid ? runtimeProcessIdentity : undefined
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await promisify(execFile)(
        getWindowsPowerShellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; ` +
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
            `if (!$p) { 'missing'; exit 0 }; ` +
            `[string]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()`
        ],
        { encoding: 'utf8', timeout: WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS, windowsHide: true }
      )
      const startedAt = stdout.trim()
      return startedAt === 'missing' ? null : startedAt ? `win32:${pid}:${startedAt}` : undefined
    } catch {
      try {
        process.kill(pid, 0)
        return pid === process.pid ? runtimeProcessIdentity : undefined
      } catch (error) {
        return hasCode(error, 'ESRCH') ? null : undefined
      }
    }
  }

  bootIdentityPromise ??= readBootIdentity()
  const bootIdentity = await bootIdentityPromise
  try {
    const { stdout } = await promisify(execFile)(
      'ps',
      ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
      {
        encoding: 'utf8',
        timeout: 1_000,
        // Why: lstart is locale-sensitive; a fixed locale keeps the identity
        // stable across relay processes for the same remote account.
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      }
    )
    const startedAt = stdout.trim()
    return startedAt ? `${process.platform}:${bootIdentity ?? 'unknown-boot'}:${startedAt}` : null
  } catch {
    try {
      process.kill(pid, 0)
      return undefined
    } catch (error) {
      if (hasCode(error, 'ESRCH')) {
        return null
      }
      return pid === process.pid ? runtimeProcessIdentity : undefined
    }
  }
}
