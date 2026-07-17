import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { parseSshRelayReleaseTag } from './ssh-relay-release-asset'
import {
  verifySshRelayArtifactManifest,
  type SshRelayManifestAcceptedKey,
  type VerifiedSshRelayArtifactManifest
} from './ssh-relay-manifest-signature'

const MAXIMUM_BYTES = 1024 * 1024
const RESOURCE_DIRECTORY = 'ssh-relay-runtime'
const MANIFEST_NAME = 'orca-ssh-relay-runtime-manifest.json'

type StableIdentity = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function sameStableIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

export function sshRelayPackagedManifestPath(resourcesPath: string): string {
  if (!isAbsolute(resourcesPath)) {
    throw new Error('SSH relay packaged resources path must be absolute')
  }
  return join(resourcesPath, RESOURCE_DIRECTORY, MANIFEST_NAME)
}

async function readStableManifestBytes(resourcesPath: string): Promise<Buffer> {
  const directoryPath = join(resourcesPath, RESOURCE_DIRECTORY)
  const directoryBefore = await lstat(directoryPath, { bigint: true })
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
    throw new Error('SSH relay packaged manifest resource directory must not be a link')
  }

  const manifestPath = sshRelayPackagedManifestPath(resourcesPath)
  const before = await lstat(manifestPath, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(MAXIMUM_BYTES)
  ) {
    throw new Error('SSH relay packaged manifest resource has an invalid file type or size')
  }

  const handle = await open(manifestPath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameStableIdentity(before, opened)) {
      throw new Error('SSH relay packaged manifest resource changed before it was opened')
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead <= 0) {
        throw new Error('SSH relay packaged manifest resource ended before its declared size')
      }
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const directoryAfter = await lstat(directoryPath, { bigint: true })
    if (
      !sameStableIdentity(opened, after) ||
      !directoryAfter.isDirectory() ||
      directoryAfter.isSymbolicLink() ||
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.mtimeNs !== directoryBefore.mtimeNs ||
      directoryAfter.ctimeNs !== directoryBefore.ctimeNs
    ) {
      throw new Error('SSH relay packaged manifest resource changed while it was read')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function parseManifestJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error('SSH relay packaged manifest resource is not valid JSON', { cause: error })
  }
}

function assertDesktopIdentity(
  manifest: VerifiedSshRelayArtifactManifest,
  appVersion: string,
  relayProtocolVersion: number
): void {
  const release = parseSshRelayReleaseTag(`v${appVersion}`)
  if (
    manifest.build.tag !== release.tag ||
    manifest.build.version !== release.version ||
    manifest.build.channel !== release.channel
  ) {
    throw new Error('SSH relay packaged manifest build identity does not match this desktop')
  }
  if (
    !Number.isSafeInteger(relayProtocolVersion) ||
    relayProtocolVersion <= 0 ||
    manifest.build.relayProtocolVersion !== relayProtocolVersion
  ) {
    throw new Error('SSH relay packaged manifest protocol does not match this desktop')
  }
}

export async function loadSshRelayPackagedManifest({
  packaged,
  resourcesPath,
  appVersion,
  relayProtocolVersion,
  acceptedKeys
}: {
  packaged: boolean
  resourcesPath: string
  appVersion: string
  relayProtocolVersion: number
  acceptedKeys: readonly SshRelayManifestAcceptedKey[]
}): Promise<VerifiedSshRelayArtifactManifest> {
  if (!packaged) {
    // Why: mutable developer paths must never become an implicit official-build trust source.
    throw new Error('SSH relay packaged manifest is available only in a packaged build')
  }
  const bytes = await readStableManifestBytes(resourcesPath)
  const manifest = verifySshRelayArtifactManifest(parseManifestJson(bytes), acceptedKeys)
  assertDesktopIdentity(manifest, appVersion, relayProtocolVersion)
  return manifest
}

export const SSH_RELAY_PACKAGED_MANIFEST_LIMITS = Object.freeze({
  maximumBytes: MAXIMUM_BYTES
})
