// Orca's own Copilot follows Copilot's latest GitHub release, the build its own installer downloads.

import { join } from 'node:path'
import type { ManagedAgentCli, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../node-runtime/managed-runtime-latest-release'
import { githubLatestReleaseAsset } from '../node-runtime/github-latest-release'
import { requireRuntimeAnswersVersion } from '../node-runtime/managed-runtime-version-check'
import { isMuslHost } from '../node-runtime/linux-libc-probe'
import { parseCliVersion } from '../../shared/app-lifecycle/identity/app-version'

const LABEL = 'GitHub Copilot'

/** The release's name for this host's build, e.g. `darwin-arm64` or `linuxmusl-x64`. */
function copilotManagedTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  const cpu = arch === 'arm64' || arch === 'x64' ? arch : null
  const os =
    platform === 'darwin' || platform === 'win32'
      ? platform
      : platform === 'linux'
        ? isMuslHost()
          ? 'linuxmusl'
          : 'linux'
        : null
  return cpu && os ? `${os}-${cpu}` : null
}

const copilotCommand = (): string => (process.platform === 'win32' ? 'copilot.exe' : 'copilot')

async function fetchLatestPin(signal?: AbortSignal): Promise<ManagedRuntimePin | null> {
  const target = copilotManagedTarget()
  const format = process.platform === 'win32' ? 'zip' : 'tar.gz'
  const release = target
    ? await githubLatestReleaseAsset({
        label: LABEL,
        repo: 'github/copilot-cli',
        version: (tag) => tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1] ?? null,
        asset: `copilot-${target}.${format}`,
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
      format,
      executables: [copilotCommand()]
    }
  )
}

const executable = (folder: string): string => join(folder, copilotCommand())

export const COPILOT_MANAGED_CLI: ManagedAgentCli = {
  runtime: {
    label: LABEL,
    root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'copilot'),
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
  available: () => copilotManagedTarget() !== null,
  executable
}
