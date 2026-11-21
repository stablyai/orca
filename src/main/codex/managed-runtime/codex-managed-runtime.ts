// Orca's own Codex follows Codex's latest GitHub release, installed as the same package Codex's own installer uses.

import { join } from 'node:path'
import { z } from 'zod'
import { getMainHttpClient } from '../../network/http-client'
import type { ManagedRuntime, ManagedRuntimePin } from '../../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../../node-runtime/managed-runtime-version-check'
import { parseCodexCliVersion } from '../../../shared/agent-launch/startup/codex-cli-installation'

// Why GitHub: the release carries the package, its checksum list and sizes in one lookup.
const LATEST_RELEASE = 'https://api.github.com/repos/openai/codex/releases/latest'
const CHECKSUMS = 'codex-package_SHA256SUMS'
const SHA256 = /^[a-f0-9]{64}$/

const releaseSchema = z.object({
  tag_name: z.string().regex(/^rust-v\d+\.\d+\.\d+$/),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().int().positive(),
      browser_download_url: z.string().url(),
      digest: z.string().nullish()
    })
  )
})

/** The package target this host downloads; null where Codex ships no build. Linux builds are static. */
export function codexManagedTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  const os =
    platform === 'darwin'
      ? 'apple-darwin'
      : platform === 'linux'
        ? 'unknown-linux-musl'
        : platform === 'win32'
          ? 'pc-windows-msvc'
          : null
  return cpu && os ? `${cpu}-${os}` : null
}

/** What a whole package needs, matching Codex's own installer's completeness check. */
function codexPackageExecutables(platform: NodeJS.Platform = process.platform): string[] {
  const exe = platform === 'win32' ? '.exe' : ''
  const required = [`bin/codex${exe}`, `bin/codex-code-mode-host${exe}`, `codex-path/rg${exe}`]
  if (platform === 'linux') {
    required.push('codex-resources/bwrap')
  }
  if (platform === 'win32') {
    required.push(
      'codex-resources/codex-command-runner.exe',
      'codex-resources/codex-windows-sandbox-setup.exe'
    )
  }
  return required
}

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const target = codexManagedTarget()
  if (!target) {
    return null
  }
  const { fetch } = getMainHttpClient()
  const response = await fetch(LATEST_RELEASE, {
    headers: { Accept: 'application/vnd.github+json' },
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Codex release lookup failed (${response.status})`)
  }
  const release = releaseSchema.parse(await response.json())
  const version = release.tag_name.slice('rust-v'.length)
  const name = `codex-package-${target}.tar.gz`
  const asset = release.assets.find((candidate) => candidate.name === name)
  const sums = release.assets.find((candidate) => candidate.name === CHECKSUMS)
  if (!asset || !sums) {
    return null
  }
  const sumsResponse = await fetch(sums.browser_download_url, { signal })
  if (!sumsResponse.ok) {
    await sumsResponse.body?.cancel().catch(() => undefined)
    throw new Error(`Codex ${version} checksum lookup failed (${sumsResponse.status})`)
  }
  const listed = (await sumsResponse.text())
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0]
    ?.toLowerCase()
  const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null
  // GitHub's own digest, when present, must agree with the published list.
  if (!listed || !SHA256.test(listed) || (digest && digest !== listed)) {
    throw new Error(`Codex ${version} has no matching checksum for ${name}`)
  }
  return {
    version,
    url: asset.browser_download_url,
    archiveSha256: listed,
    archiveBytes: asset.size,
    format: 'tar.gz',
    executables: codexPackageExecutables()
  }
}

/** The executable inside a Codex release folder; Codex finds its helpers beside it. */
export function codexManagedExecutable(folder: string): string {
  return join(folder, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

export const CODEX_MANAGED_RUNTIME: ManagedRuntime = {
  label: 'Codex',
  root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'codex'),
  ...followLatestRelease(fetchLatestPin),
  validate: (folder, pin, signal) =>
    requireRuntimeAnswersVersion(
      codexManagedExecutable(folder),
      'Codex',
      pin.version,
      (answered) => parseCodexCliVersion(answered) === pin.version,
      signal
    )
}
