// Orca's own Codex follows Codex's latest GitHub release, installed as the same package Codex's own installer uses.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../../node-runtime/managed-runtime-latest-release'
import { githubLatestReleaseAsset } from '../../node-runtime/github-latest-release'
import { requireRuntimeAnswersVersion } from '../../node-runtime/managed-runtime-version-check'
import { parseCodexCliVersion } from '../../../shared/agent-launch/startup/codex-cli-installation'

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
  const release = target
    ? await githubLatestReleaseAsset({
        label: 'Codex',
        repo: 'openai/codex',
        version: (tag) => tag.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1] ?? null,
        asset: `codex-package-${target}.tar.gz`,
        checksums: 'codex-package_SHA256SUMS',
        signal
      })
    : null
  return (
    release && {
      version: release.version,
      url: release.url,
      archiveSha256: release.sha256,
      archiveBytes: release.bytes,
      format: 'tar.gz',
      executables: codexPackageExecutables()
    }
  )
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
