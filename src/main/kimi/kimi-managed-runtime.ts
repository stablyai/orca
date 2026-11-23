// Orca's own Kimi Code follows the release its own installer downloads, hashed by that release's manifest.

import { join } from 'node:path'
import { z } from 'zod'
import { getMainHttpClient } from '../network/http-client'
import type { ManagedAgentCli, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../node-runtime/managed-runtime-version-check'
import { runtimeDownloadBytes } from '../node-runtime/runtime-download-size'
import { isMuslHost } from '../node-runtime/linux-libc-probe'
import { isValidAppVersion, parseCliVersion } from '../../shared/app-lifecycle/identity/app-version'

const LABEL = 'Kimi Code'
const RELEASES = 'https://code.kimi.com/kimi-code'

const manifestSchema = z.object({
  version: z.string(),
  platforms: z.record(
    z.string(),
    z.object({
      filename: z.string().regex(/^[\w.-]+$/),
      checksum: z.string().regex(/^[a-f0-9]{64}$/)
    })
  )
})

/** The manifest's name for this host; Kimi Code ships no musl build. */
function kimiManagedTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const cpu = arch === 'arm64' || arch === 'x64' ? arch : null
  const os =
    platform === 'darwin' || platform === 'win32' || (platform === 'linux' && !isMuslHost())
      ? platform
      : null
  return cpu && os ? `${os}-${cpu}` : null
}

const kimiCommand = (): string => (process.platform === 'win32' ? 'kimi.exe' : 'kimi')

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const target = kimiManagedTarget()
  if (!target) {
    return null
  }
  const { fetch } = getMainHttpClient()
  const latest = await fetch(`${RELEASES}/latest`, { signal })
  if (!latest.ok) {
    await latest.body?.cancel().catch(() => undefined)
    throw new Error(`${LABEL} release lookup failed (${latest.status})`)
  }
  const version = (await latest.text()).trim()
  if (!isValidAppVersion(version)) {
    throw new Error(`${LABEL} answered an unexpected latest release`)
  }
  const manifestResponse = await fetch(`${RELEASES}/binaries/${version}/manifest.json`, { signal })
  if (!manifestResponse.ok) {
    await manifestResponse.body?.cancel().catch(() => undefined)
    throw new Error(`${LABEL} ${version} manifest lookup failed (${manifestResponse.status})`)
  }
  const manifest = manifestSchema.parse(await manifestResponse.json())
  const build = manifest.platforms[target]
  if (manifest.version !== version || !build) {
    return null
  }
  const url = `${RELEASES}/binaries/${version}/${build.filename}`
  const bytes = await runtimeDownloadBytes(url, LABEL, signal)
  return {
    version,
    url,
    archiveSha256: build.checksum,
    archiveBytes: bytes,
    format: 'file',
    members: [{ path: kimiCommand(), sha256: build.checksum, bytes }]
  }
}

const executable = (folder: string): string => join(folder, kimiCommand())

export const KIMI_MANAGED_CLI: ManagedAgentCli = {
  runtime: {
    label: LABEL,
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'kimi'),
    ...followLatestRelease(fetchLatestPin),
    validate: (folder, pin, signal) =>
      requireRuntimeAnswersVersion(
        executable(folder),
        LABEL,
        pin.version,
        (answered) => parseCliVersion(answered) === pin.version,
        signal
      )
  },
  available: () => kimiManagedTarget() !== null,
  executable
}
