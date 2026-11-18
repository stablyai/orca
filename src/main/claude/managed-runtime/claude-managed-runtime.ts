// Orca's own Claude Code follows the user's Claude update channel; chats prefer the user's own install.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { readInheritedPath } from '../../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../../pty/environment/windows-path-segment-merge'
import { z } from 'zod'
import { getMainHttpClient } from '../../network/http-client'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import {
  ManagedRuntimeStartError,
  resolveInstalledRuntimeRelease,
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

function isMuslHost(): boolean {
  if (process.platform !== 'linux') {
    return false
  }
  // glibc builds report their runtime glibc version; musl builds have none.
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
    ?.header
  return !header?.glibcVersionRuntime
}

const channelSettingsSchema = z.object({
  autoUpdatesChannel: z.enum(['latest', 'stable']).optional()
})

/** Claude's own `autoUpdatesChannel`; managed settings win over the user's, and Claude defaults to latest. */
export function claudeUpdateChannel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): 'latest' | 'stable' {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const managed =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? join(env.PROGRAMFILES || 'C:\\Program Files', 'ClaudeCode')
        : '/etc/claude-code'
  const channels = [join(configDir, 'settings.json'), join(managed, 'managed-settings.json')].map(
    (path) => {
      try {
        return channelSettingsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).data
          ?.autoUpdatesChannel
      } catch {
        return undefined
      }
    }
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
  const versionResponse = await fetch(`${RELEASES}/${claudeUpdateChannel()}`, { signal })
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

function validateClaudeRelease(
  folder: string,
  pin: ManagedRuntimePin,
  signal: AbortSignal
): Promise<void> {
  const [member] = pin.members
  return new Promise((resolve, reject) => {
    execFile(
      join(folder, member?.path ?? 'claude'),
      ['--version'],
      { signal, timeout: VALIDATE_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed && !signal.aborted
          reject(
            new ManagedRuntimeStartError(
              error.message,
              timedOut
                ? { kind: 'timeout', timeoutMs: VALIDATE_TIMEOUT_MS }
                : {
                    kind: 'exit',
                    exit: {
                      code: typeof error.code === 'number' ? error.code : null,
                      signal: error.signal ?? null,
                      // A string code (ENOENT, EACCES) means the process never started.
                      processless: typeof error.code === 'string'
                    },
                    stderr: String(stderr)
                  },
              { cause: error }
            )
          )
          return
        }
        const answered = String(stdout).trim()
        if (!answered.startsWith(pin.version)) {
          reject(
            new ManagedRuntimeStartError('Claude answered with another version', {
              kind: 'version',
              answered,
              expected: pin.version
            })
          )
          return
        }
        resolve()
      }
    )
  })
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

/** Orca's installed Claude on this host, used only when the user has none of their own. */
export function managedClaudeCommand(dataDirectory = getProfileUserDataPath()): string | null {
  const root = CLAUDE_MANAGED_RUNTIME.root(dataDirectory)
  const { release } = resolveInstalledRuntimeRelease(root, CLAUDE_MANAGED_RUNTIME.pin())
  return release ? claudeManagedExecutable(release.folder) : null
}

/** Last on PATH, so `claude auth login` and CLI tabs reach Orca's copy and never shadow the user's own. */
export function appendManagedClaudeDirToChildPath(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  delete env.ORCA_MANAGED_AGENT_PATH
  const command = managedClaudeCommand()
  if (!command) {
    return
  }
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
