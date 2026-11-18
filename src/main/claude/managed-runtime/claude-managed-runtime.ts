// Orca's own Claude Code follows the user's Claude update channel; chats prefer the user's own install.

import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readInheritedPath } from '../../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'
import { z } from 'zod'
import { getMainHttpClient } from '../../network/http-client'
import {
  ManagedRuntimeStartError,
  type ManagedRuntime,
  type ManagedRuntimePin
} from '../../node-runtime/managed-runtime-release'

const RELEASES = 'https://downloads.claude.ai/claude-code-releases'
const REFRESH_MS = 60 * 60_000
const VALIDATE_TIMEOUT_MS = 60_000

const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platforms: z.record(
    z.string(),
    z.object({
      binary: z.string().regex(/^claude(\.exe)?$/),
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().positive()
    })
  )
})

/** The release folder name this host downloads; null where Claude ships no native build. */
export function claudeManagedPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslHost()
): string | null {
  if (arch !== 'x64' && arch !== 'arm64') {
    return null
  }
  if (platform === 'darwin' || platform === 'win32') {
    return `${platform}-${arch}`
  }
  return platform === 'linux' ? `linux-${arch}${musl ? '-musl' : ''}` : null
}

let muslHost: boolean | undefined

// Building a process report is slow and synchronous, and the libc can't change while running.
function isMuslHost(): boolean {
  if (process.platform !== 'linux') {
    return false
  }
  if (muslHost === undefined) {
    // glibc builds report their runtime glibc version; musl builds have none.
    const report: unknown = process.report?.getReport()
    const header = report && typeof report === 'object' && 'header' in report ? report.header : null
    muslHost = !(header && typeof header === 'object' && 'glibcVersionRuntime' in header)
  }
  return muslHost
}

const channelSettingsSchema = z.object({
  autoUpdatesChannel: z.enum(['latest', 'stable']).optional()
})

/** Claude's own `autoUpdatesChannel`; managed settings win over the user's, and Claude defaults to latest. */
export async function claudeUpdateChannel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<'latest' | 'stable'> {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const managed =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? join(env.PROGRAMFILES || 'C:\\Program Files', 'ClaudeCode')
        : '/etc/claude-code'
  const channels = await Promise.all(
    [join(configDir, 'settings.json'), join(managed, 'managed-settings.json')].map(async (path) => {
      try {
        return channelSettingsSchema.safeParse(JSON.parse(await readFile(path, 'utf8'))).data
          ?.autoUpdatesChannel
      } catch {
        return undefined
      }
    })
  )
  return channels.findLast((channel) => channel !== undefined) ?? 'latest'
}

let latest: { pin: ManagedRuntimePin | null; at: number } | null = null
let lookup: Promise<void> | null = null

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const platform = claudeManagedPlatform()
  if (!platform) {
    return null
  }
  const { fetch } = getMainHttpClient()
  const versionResponse = await fetch(`${RELEASES}/${await claudeUpdateChannel()}`, { signal })
  if (!versionResponse.ok) {
    throw new Error(`Claude release lookup failed (${versionResponse.status})`)
  }
  const version = (await versionResponse.text()).trim()
  const manifestResponse = await fetch(`${RELEASES}/${encodeURIComponent(version)}/manifest.json`, {
    signal
  })
  if (!manifestResponse.ok) {
    throw new Error(`Claude ${version} manifest lookup failed (${manifestResponse.status})`)
  }
  const manifest = manifestSchema.parse(await manifestResponse.json())
  const build = manifest.platforms[platform]
  if (manifest.version !== version || !build) {
    return null
  }
  return {
    version,
    url: `${RELEASES}/${version}/${platform}/${build.binary}`,
    archiveSha256: build.checksum,
    archiveBytes: build.size,
    format: 'file',
    members: [{ path: build.binary, sha256: build.checksum, bytes: build.size }]
  }
}

/** Shared by every caller within the hour; a failed lookup keeps the last known release. */
async function refreshLatestPin(signal?: AbortSignal): Promise<void> {
  if (latest && Date.now() - latest.at < REFRESH_MS) {
    return
  }
  lookup ??= fetchLatestPin(signal)
    .then((pin) => {
      latest = { pin, at: Date.now() }
    })
    .finally(() => {
      lookup = null
    })
  await lookup
}

async function validateClaudeRelease(
  folder: string,
  pin: ManagedRuntimePin,
  signal: AbortSignal
): Promise<void> {
  const [member] = pin.members
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program: join(folder, member?.path ?? 'claude'),
      args: ['--version'],
      timeoutMs: VALIDATE_TIMEOUT_MS,
      signal
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ManagedRuntimeStartError(
      message,
      { kind: 'exit', exit: { code: null, signal: null, processless: true }, stderr: '' },
      { cause: error }
    )
  }
  signal.throwIfAborted()
  if (result.timedOut) {
    throw new ManagedRuntimeStartError('Claude did not answer', {
      kind: 'timeout',
      timeoutMs: VALIDATE_TIMEOUT_MS
    })
  }
  if (result.code !== 0) {
    throw new ManagedRuntimeStartError('Claude exited', {
      kind: 'exit',
      exit: { code: result.code, signal: result.signal, processless: false },
      stderr: result.stderr
    })
  }
  const answered = result.stdout.trim()
  if (!answered.startsWith(pin.version)) {
    throw new ManagedRuntimeStartError('Claude answered with another version', {
      kind: 'version',
      answered,
      expected: pin.version
    })
  }
}

export const CLAUDE_MANAGED_RUNTIME: ManagedRuntime = {
  label: 'Claude',
  root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'claude'),
  pin: () => latest?.pin ?? null,
  refreshPin: refreshLatestPin,
  validate: validateClaudeRelease
}

/** The executable inside a Claude release folder. */
export function claudeManagedExecutable(folder: string): string {
  return join(folder, process.platform === 'win32' ? 'claude.exe' : 'claude')
}

let installedFolder: string | null = null

/** The installation reports each release it reads from disk, so lookups here never touch the disk. */
export function rememberManagedClaudeRelease(folder: string | null): void {
  installedFolder = folder
}

/** Orca's installed Claude on this host, used only when the user has none of their own. */
export function managedClaudeCommand(): string | null {
  if (!installedFolder) {
    return null
  }
  managedUseListener?.()
  return claudeManagedExecutable(installedFolder)
}

let managedUseListener: (() => void) | null = null

/** Told each time a launch resolves to Orca's copy, so updates follow real use instead of a timer. */
export function onManagedClaudeUse(listener: () => void): void {
  managedUseListener = listener
}

/** Last on PATH, so `claude auth login` and CLI tabs reach Orca's copy and never shadow the user's own. */
export function appendManagedClaudeDirToChildPath(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  delete env.ORCA_MANAGED_AGENT_PATH
  // Opening a terminal isn't use of Claude, so this doesn't trigger an update check.
  if (!installedFolder) {
    return
  }
  const command = claudeManagedExecutable(installedFolder)
  const key = resolvePathEnvKey(env, platform)
  const separator = platform === 'win32' ? ';' : delimiter
  const entries = readInheritedPath(env, platform).split(separator).filter(Boolean)
  const folder = dirname(command)
  if (!entries.includes(folder)) {
    env[key] = [...entries, folder].join(separator)
  }
  // Startup files re-add it after a login profile rebuilds PATH.
  env.ORCA_MANAGED_AGENT_PATH = folder
}
