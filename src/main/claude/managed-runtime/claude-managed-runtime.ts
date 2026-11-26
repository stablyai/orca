// Orca's own Claude Code follows the user's Claude update channel; chats prefer the user's own install.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { getMainHttpClient } from '../../network/http-client'
import type { ManagedRuntime, ManagedRuntimePin } from '../../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../../node-runtime/managed-runtime-version-check'
import { isMuslHost } from '../../node-runtime/linux-libc-probe'

const RELEASES = 'https://downloads.claude.ai/claude-code-releases'

const manifestSchema = lazyZodSchema(() =>
  z.object({
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
)

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

const channelSettingsSchema = lazyZodSchema(() =>
  z.object({
    autoUpdatesChannel: z.enum(['latest', 'stable']).optional()
  })
)

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

async function validateClaudeRelease(
  folder: string,
  pin: ManagedRuntimePin,
  signal: AbortSignal
): Promise<void> {
  await requireRuntimeAnswersVersion(
    claudeManagedExecutable(folder),
    'Claude',
    pin.version,
    (answered) => answered.startsWith(pin.version),
    signal
  )
}

export const CLAUDE_MANAGED_RUNTIME: ManagedRuntime = {
  label: 'Claude',
  root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'claude'),
  ...followLatestRelease(fetchLatestPin),
  validate: validateClaudeRelease
}

/** The executable inside a Claude release folder. */
export function claudeManagedExecutable(folder: string): string {
  return join(folder, process.platform === 'win32' ? 'claude.exe' : 'claude')
}
