// Orca's own Grok is the native build from Grok's npm platform package, verified by npm's published sha512.
// Why npm: Grok's own installer downloads a binary that has no published checksum.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import { z } from 'zod'
import { getMainHttpClient } from '../network/http-client'
import type { ManagedAgentCli, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../node-runtime/managed-runtime-version-check'
import { runtimeDownloadBytes } from '../node-runtime/runtime-download-size'
import { parseCliVersion } from '../../shared/app-lifecycle/identity/app-version'

const LABEL = 'Grok'
const REGISTRY = 'https://registry.npmjs.org'
const PACKAGE = '@xai-official/grok'

const latestSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) })
const platformPackageSchema = z.object({
  version: z.string(),
  dist: z.object({
    tarball: z.string().url().startsWith(`${REGISTRY}/`),
    integrity: z.string().startsWith('sha512-')
  })
})

/** The npm package holding this host's build; its Linux builds are static, so they run on musl too. */
function grokPlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const supported =
    ['darwin', 'linux', 'win32'].includes(platform) && ['arm64', 'x64'].includes(arch)
  return supported ? `${PACKAGE}-${platform}-${arch}` : null
}

const grokCommand = (): string => (process.platform === 'win32' ? 'bin/grok.exe' : 'bin/grok')

/** npm's `sha512-<base64>` integrity as hex; null for anything that is not one sha512. */
function npmSha512Hex(integrity: string): string | null {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
  return integrity.startsWith('sha512-') && hex.length === 128 ? hex : null
}

async function registryJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await getMainHttpClient().fetch(url, {
    headers: { Accept: 'application/json' },
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${LABEL} release lookup failed (${response.status})`)
  }
  return response.json()
}

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const platformPackage = grokPlatformPackage()
  if (!platformPackage) {
    return null
  }
  const { version } = latestSchema.parse(
    await registryJson(`${REGISTRY}/${PACKAGE}/latest`, signal)
  )
  const build = platformPackageSchema.parse(
    await registryJson(`${REGISTRY}/${platformPackage}/${version}`, signal)
  )
  const sha512 = npmSha512Hex(build.dist.integrity)
  if (build.version !== version || !sha512) {
    throw new Error(`${LABEL} ${version} has no matching build for ${platformPackage}`)
  }
  return {
    version,
    url: build.dist.tarball,
    archiveSha512: sha512,
    archiveBytes: await runtimeDownloadBytes(build.dist.tarball, LABEL, signal),
    format: 'tar.gz',
    executables: [grokCommand()]
  }
}

const executable = (folder: string): string => join(folder, ...grokCommand().split('/'))

// The package ships its binary brotli-compressed to fit npm's size limit.
async function unpackGrok(folder: string): Promise<void> {
  const command = executable(folder)
  const compressed = join(folder, 'package', `${grokCommand()}.br`)
  await mkdir(join(folder, 'bin'), { recursive: true })
  await pipeline(
    createReadStream(compressed),
    createBrotliDecompress(),
    createWriteStream(command, { mode: 0o755 })
  )
  await rm(join(folder, 'package'), { recursive: true, force: true })
}

export const GROK_MANAGED_CLI: ManagedAgentCli = {
  runtime: {
    label: LABEL,
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'grok'),
    ...followLatestRelease(fetchLatestPin),
    prepare: unpackGrok,
    validate: (folder, pin, signal) =>
      requireRuntimeAnswersVersion(
        executable(folder),
        LABEL,
        pin.version,
        (answered) => parseCliVersion(answered) === pin.version,
        signal
      )
  },
  available: () => grokPlatformPackage() !== null,
  executable
}
