// Orca's own copy of an ACP agent whose official build is an archive listed in the ACP Registry.

import { join } from 'node:path'
import { getMainHttpClient } from '../../network/http-client'
import type { ManagedRuntime, ManagedRuntimePin } from '../../node-runtime/managed-runtime-release'
import { followLatestRelease } from '../../node-runtime/managed-runtime-latest-release'
import { requireRuntimeAnswersVersion } from '../../node-runtime/managed-runtime-version-check'
import { agentCliMinimumVersion } from '../../agent-launch/preflight/agent-cli-minimum-version'
import {
  compareAppVersions,
  parseCliVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import {
  acpRegistryAgent,
  acpRegistryTarget,
  knownAcpRegistryAgent,
  type AcpRegistryBinaryTarget
} from './acp-registry-catalog'

export type AcpRegistryManagedAgent = {
  label: string
  /** The folder under Orca's agent runtimes. */
  agent: string
  registryId: string
  /** Where the registry's `cmd` sits in the release, so launches find it without reading the disk. */
  command: (platform: NodeJS.Platform) => string
  /** The launch gate's floors; a listed release below them is never installed. */
  minimumVersions: readonly string[]
}

/** `cmd` as a release member path; null for anything that could leave the release folder. */
function releaseMember(cmd: string): string | null {
  const segments = cmd.replace(/^\.[\\/]/, '').split(/[\\/]/)
  return segments.every(
    (segment) => segment && !['.', '..'].includes(segment) && !/:/.test(segment)
  )
    ? segments.join('/')
    : null
}

function archiveFormat(url: string): 'tar.gz' | 'zip' | null {
  const { pathname } = new URL(url)
  return pathname.endsWith('.tar.gz') ? 'tar.gz' : pathname.endsWith('.zip') ? 'zip' : null
}

// Some publishers list no hash in the registry but publish one beside the archive.
async function archiveSha256(
  target: AcpRegistryBinaryTarget,
  signal?: AbortSignal
): Promise<string | null> {
  if (target.sha256) {
    return target.sha256
  }
  const response = await getMainHttpClient().fetch(`${target.archive}.sha256`, {
    redirect: 'follow',
    signal
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  const listed = (await response.text()).trim().split(/\s+/)[0]?.toLowerCase()
  return listed && /^[a-f0-9]{64}$/.test(listed) ? listed : null
}

async function archiveBytes(url: string, label: string, signal?: AbortSignal): Promise<number> {
  const response = await getMainHttpClient().fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal
  })
  if (!response.ok) {
    throw new Error(`${label} download size lookup failed (${response.status})`)
  }
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase() || 'identity'
  const bytes = Number(response.headers.get('content-length'))
  if (encoding !== 'identity' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${label} download size is unknown`)
  }
  return bytes
}

async function fetchRegistryPin(
  managed: AcpRegistryManagedAgent,
  signal?: AbortSignal
): Promise<ManagedRuntimePin | null> {
  const key = acpRegistryTarget()
  const listing = key ? await acpRegistryAgent(managed.registryId, signal) : null
  const target = key ? listing?.distribution.binary?.[key] : undefined
  if (!listing || !target) {
    return null
  }
  const { label } = managed
  const { version } = listing
  const minimum = agentCliMinimumVersion(version, managed.minimumVersions)
  const member = releaseMember(target.cmd)
  const format = archiveFormat(target.archive)
  // Launches find Orca's copy at a fixed path, so a moved command waits for an Orca update.
  if (
    (minimum !== null && compareAppVersions(version, minimum) < 0) ||
    !member ||
    member !== managed.command(process.platform) ||
    !format
  ) {
    console.warn(`[acp-registry] ${label} ${version} for ${key} is not one Orca can run`)
    return null
  }
  const [sha256, bytes] = await Promise.all([
    archiveSha256(target, signal),
    archiveBytes(target.archive, label, signal)
  ])
  if (!sha256) {
    console.warn(`[acp-registry] ${label} ${version} for ${key} publishes no checksum`)
    return null
  }
  return {
    version,
    url: target.archive,
    archiveSha256: sha256,
    archiveBytes: bytes,
    format,
    executables: [member]
  }
}

/** Answers its version on the release line the registry lists (e.g. `2026.11.17-f532c45` for `2026.11.17`). */
function answersVersion(answered: string, version: string): boolean {
  const parsed = parseCliVersion(answered)
  return parsed === version || parsed?.startsWith(`${version}-`) === true
}

export function acpRegistryManagedRuntime(managed: AcpRegistryManagedAgent): {
  runtime: ManagedRuntime
  available: () => boolean
  executable: (folder: string) => string
} {
  const executable = (folder: string): string =>
    join(folder, ...managed.command(process.platform).split('/'))
  return {
    runtime: {
      label: managed.label,
      root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', managed.agent),
      ...followLatestRelease((signal) => fetchRegistryPin(managed, signal)),
      validate: (folder, pin, signal) =>
        requireRuntimeAnswersVersion(
          executable(folder),
          managed.label,
          pin.version,
          (answered) => answersVersion(answered, pin.version),
          signal
        )
    },
    // Before the registry is read, a host with a known target offers the install; the install looks it up.
    available: () => {
      const key = acpRegistryTarget()
      const known = knownAcpRegistryAgent(managed.registryId)
      return (
        key !== null && (known === undefined || known?.distribution.binary?.[key] !== undefined)
      )
    },
    executable
  }
}
