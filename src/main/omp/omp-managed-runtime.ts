// Orca's own OMP follows OMP's latest GitHub release, the build its own installer downloads.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ManagedAgentCli, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../node-runtime/managed-runtime-latest-release'
import { githubLatestReleaseAsset } from '../node-runtime/github-latest-release'
import { requireRuntimeAnswersVersion } from '../node-runtime/managed-runtime-version-check'
import { isMuslHost } from '../node-runtime/linux-libc-probe'
import { parseCliVersion } from '../../shared/app-lifecycle/identity/app-version'

const LABEL = 'OMP'

/** The release's asset for this host, e.g. `omp-darwin-arm64` or `omp-windows-x64.exe`. */
function ompManagedAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const cpu = arch === 'arm64' || arch === 'x64' ? arch : null
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? isMuslHost()
          ? 'linux-musl'
          : 'linux'
        : platform === 'win32'
          ? 'windows'
          : null
  return cpu && os ? `omp-${os}-${cpu}${os === 'windows' ? '.exe' : ''}` : null
}

const ompCommand = (): string => (process.platform === 'win32' ? 'bin/omp.exe' : 'bin/omp')

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const asset = ompManagedAsset()
  const release = asset
    ? await githubLatestReleaseAsset({
        label: LABEL,
        repo: 'can1357/oh-my-pi',
        version: (tag) => tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null,
        asset,
        checksums: 'SHA256SUMS.txt',
        signal
      })
    : null
  return (
    release && {
      version: release.version,
      url: release.url,
      archiveSha256: release.sha256,
      archiveBytes: release.bytes,
      format: 'file',
      members: [{ path: ompCommand(), sha256: release.sha256, bytes: release.bytes }]
    }
  )
}

const executable = (folder: string): string => join(folder, ...ompCommand().split('/'))

export const OMP_MANAGED_CLI: ManagedAgentCli = {
  runtime: {
    label: LABEL,
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'omp'),
    ...followLatestRelease(fetchLatestPin),
    // OMP reads this beside its bin folder and leaves updates to the named manager instead of replacing itself.
    prepare: (folder) => writeFile(join(folder, 'manager.json'), JSON.stringify({ name: 'Orca' })),
    validate: (folder, pin, signal) =>
      requireRuntimeAnswersVersion(
        executable(folder),
        LABEL,
        pin.version,
        (answered) => parseCliVersion(answered) === pin.version,
        signal
      )
  },
  available: () => ompManagedAsset() !== null,
  executable
}
