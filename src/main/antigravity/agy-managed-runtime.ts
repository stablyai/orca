// Orca's own agy is the build Google's own installer downloads, verified by the sha512 its manifest
// publishes. Why not that installer: it is unpinned and `agy install` edits shell profiles and PATH.

import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { getMainHttpClient } from '../network/http-client'
import type { ManagedAgentCli, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../node-runtime/managed-runtime-version-check'
import { runtimeDownloadBytes } from '../node-runtime/runtime-download-size'
import { isMuslHost } from '../node-runtime/linux-libc-probe'
import { parseCliVersion } from '../../shared/app-lifecycle/identity/app-version'

const LABEL = 'Antigravity'
const MANIFESTS = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const BUILDS = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/'
// Orca updates its copy itself; agy's own updater would replace it unverified.
const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }

const manifestSchema = lazyZodSchema(() =>
  z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    // Parsed, so a `..` segment can't climb out of Google's folder.
    url: z
      .string()
      .url()
      .refine((url) => new URL(url).href.startsWith(BUILDS)),
    sha512: z
      .string()
      .regex(/^[a-f0-9]{128}$/i)
      .transform((hex) => hex.toLowerCase())
  })
)

/** The manifest naming this host's build; null where Google ships none. */
export function agyManifestPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMuslHost()
): string | null {
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null
  if (!cpu) {
    return null
  }
  if (platform === 'darwin' || platform === 'win32') {
    return `${platform === 'darwin' ? 'darwin' : 'windows'}_${cpu}`
  }
  return platform === 'linux' ? `linux_${cpu}${musl ? '_musl' : ''}` : null
}

const agyCommand = (): string => (process.platform === 'win32' ? 'agy.exe' : 'agy')

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const platform = agyManifestPlatform()
  if (!platform) {
    return null
  }
  const response = await getMainHttpClient().fetch(`${MANIFESTS}/${platform}.json`, {
    headers: { Accept: 'application/json' },
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${LABEL} release lookup failed (${response.status})`)
  }
  const { version, url, sha512 } = manifestSchema.parse(await response.json())
  // As Google's installer does, the download's name says what it is: a bare exe, or a tar.gz.
  const format = new URL(url).pathname.endsWith(process.platform === 'win32' ? '.exe' : '.tar.gz')
    ? process.platform === 'win32'
      ? 'file'
      : 'tar.gz'
    : null
  if (!format) {
    throw new Error(`${LABEL} ${version} is published in a form Orca can't install: ${url}`)
  }
  return {
    version,
    url,
    archiveSha512: sha512,
    archiveBytes: await runtimeDownloadBytes(url, LABEL, signal),
    format,
    executables: [agyCommand()]
  }
}

const executable = (folder: string): string => join(folder, agyCommand())

// The archive names its binary `antigravity`; terminals given Orca's folder on PATH run `agy`.
async function nameAgy(folder: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(join(folder, 'antigravity'), executable(folder)).catch((error: unknown) => {
      throw new Error(`The ${LABEL} download has no antigravity program.`, { cause: error })
    })
  }
}

export const AGY_MANAGED_CLI: ManagedAgentCli = {
  runtime: {
    label: LABEL,
    // Apart from the legacy ACP server's `agent-runtimes/antigravity`.
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'agy'),
    ...followLatestRelease(fetchLatestPin),
    prepare: nameAgy,
    validate: (folder, pin, signal) =>
      requireRuntimeAnswersVersion(
        executable(folder),
        LABEL,
        pin.version,
        (answered) => parseCliVersion(answered) === pin.version,
        signal,
        AGY_ENV
      )
  },
  available: () => agyManifestPlatform() !== null,
  executable,
  standsInFor: 'agy'
}
