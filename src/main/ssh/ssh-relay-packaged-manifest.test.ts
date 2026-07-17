import { mkdir, mkdtemp, open, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import {
  loadSshRelayPackagedManifest,
  sshRelayPackagedManifestPath,
  SSH_RELAY_PACKAGED_MANIFEST_LIMITS
} from './ssh-relay-packaged-manifest'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  type SshRelayManifestAcceptedKey
} from './ssh-relay-manifest-signature'

const temporaryDirectories: string[] = []
const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const acceptedKey: SshRelayManifestAcceptedKey = {
  keyId: sshRelayManifestKeyId(keyPair.publicKey),
  publicKey: keyPair.publicKey
}

type FileHandleBufferRead = <TBuffer extends Uint8Array>(
  this: FileHandle,
  buffer: TBuffer,
  offset?: number,
  length?: number,
  position?: number | null
) => Promise<{ bytesRead: number; buffer: TBuffer }>

async function resourcesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-packaged-manifest-'))
  temporaryDirectories.push(root)
  return join(root, 'Resources')
}

function signedManifest({
  version = '1.4.140-rc.1',
  channel = 'rc',
  relayProtocolVersion = 1
}: {
  version?: string
  channel?: 'stable' | 'rc' | 'perf'
  relayProtocolVersion?: number
} = {}) {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.build = {
    tag: `v${version}`,
    version,
    channel,
    relayProtocolVersion
  }
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  return manifest
}

async function writeManifest(resourcesPath: string, manifest = signedManifest()): Promise<void> {
  const path = sshRelayPackagedManifestPath(resourcesPath)
  await mkdir(join(resourcesPath, 'ssh-relay-runtime'), { recursive: true })
  await writeFile(path, JSON.stringify(manifest))
}

function loadOptions(resourcesPath: string) {
  return {
    packaged: true,
    resourcesPath,
    appVersion: '1.4.140-rc.1',
    relayProtocolVersion: 1,
    acceptedKeys: [acceptedKey]
  }
}

async function limitFileHandleReads(
  maximumBytes: number,
  afterFirstRead?: () => Promise<void>
): Promise<ReturnType<typeof vi.spyOn>> {
  const resourcesPath = await resourcesRoot()
  const probePath = join(resourcesPath, 'probe')
  await mkdir(resourcesPath, { recursive: true })
  await writeFile(probePath, 'probe')
  const probe = await open(probePath, 'r')
  const prototype = Object.getPrototypeOf(probe) as { read: FileHandleBufferRead }
  await probe.close()
  const originalRead = prototype.read
  let pendingAfterFirstRead = afterFirstRead
  return vi.spyOn(prototype, 'read').mockImplementation(async function <TBuffer extends Uint8Array>(
    this: FileHandle,
    buffer: TBuffer,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null
  ) {
    const result = await originalRead.call(
      this,
      buffer,
      offset,
      Math.min(length, maximumBytes),
      position
    )
    if (result.bytesRead > 0 && pendingAfterFirstRead) {
      const callback = pendingAfterFirstRead
      pendingAfterFirstRead = undefined
      await callback()
    }
    return result
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay packaged manifest', () => {
  it('pins one fixed absolute resource path and a bounded stable read', async () => {
    const resourcesPath = await resourcesRoot()
    expect(sshRelayPackagedManifestPath(resourcesPath)).toBe(
      join(resourcesPath, 'ssh-relay-runtime', 'orca-ssh-relay-runtime-manifest.json')
    )
    expect(SSH_RELAY_PACKAGED_MANIFEST_LIMITS).toEqual({ maximumBytes: 1024 * 1024 })
    expect(Object.isFrozen(SSH_RELAY_PACKAGED_MANIFEST_LIMITS)).toBe(true)
    expect(() => sshRelayPackagedManifestPath('relative/resources')).toThrow(/absolute/i)
    await expect(
      loadSshRelayPackagedManifest({ ...loadOptions(resourcesPath), packaged: false })
    ).rejects.toThrow(/packaged/i)
  })

  it('verifies an accepted signature and exact stable, RC, and perf desktop identities', async () => {
    const resourcesPath = await resourcesRoot()
    for (const value of [
      { version: '1.4.140', channel: 'stable' as const },
      { version: '1.4.140-rc.1', channel: 'rc' as const },
      { version: '1.4.140-rc.1.perf', channel: 'perf' as const }
    ]) {
      await writeManifest(resourcesPath, signedManifest(value))
      const manifest = await loadSshRelayPackagedManifest({
        ...loadOptions(resourcesPath),
        appVersion: value.version
      })
      expect(manifest.build).toEqual({
        tag: `v${value.version}`,
        version: value.version,
        channel: value.channel,
        relayProtocolVersion: 1
      })
      expect(Object.isFrozen(manifest)).toBe(true)
      expect(Object.isFrozen(manifest.tuples[0].entries)).toBe(true)
    }
  })

  it('completes partial reads and detects mutation before verification', async () => {
    const resourcesPath = await resourcesRoot()
    await writeManifest(resourcesPath)

    const partialRead = await limitFileHandleReads(7)
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).resolves.toMatchObject({
      build: { tag: 'v1.4.140-rc.1' }
    })
    partialRead.mockRestore()

    const manifestPath = sshRelayPackagedManifestPath(resourcesPath)
    const mutateAfterFirstRead = await limitFileHandleReads(7, async () => {
      await writeFile(manifestPath, JSON.stringify(signedManifest()))
      const future = new Date(Date.now() + 60_000)
      await utimes(manifestPath, future, future)
    })
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(
      /changed while it was read/i
    )
    mutateAfterFirstRead.mockRestore()
  })

  it('fails closed for missing, malformed, oversized, and linked resources', async () => {
    const resourcesPath = await resourcesRoot()
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(
      /manifest|resource/i
    )

    await mkdir(join(resourcesPath, 'ssh-relay-runtime'), { recursive: true })
    await writeFile(sshRelayPackagedManifestPath(resourcesPath), '{not-json')
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(/json/i)

    await writeFile(
      sshRelayPackagedManifestPath(resourcesPath),
      Buffer.alloc(SSH_RELAY_PACKAGED_MANIFEST_LIMITS.maximumBytes + 1)
    )
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(/size/i)

    await rm(join(resourcesPath, 'ssh-relay-runtime'), { recursive: true })
    const linkedTarget = join(resourcesPath, 'linked-manifest')
    await mkdir(linkedTarget, { recursive: true })
    await writeFile(
      join(linkedTarget, 'orca-ssh-relay-runtime-manifest.json'),
      JSON.stringify(signedManifest())
    )
    await symlink(linkedTarget, join(resourcesPath, 'ssh-relay-runtime'), 'junction')
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(
      /directory|link/i
    )
  })

  it('rejects empty, unknown, mismatched, and invalid accepted-key state', async () => {
    const resourcesPath = await resourcesRoot()
    await writeManifest(resourcesPath)
    await expect(
      loadSshRelayPackagedManifest({ ...loadOptions(resourcesPath), acceptedKeys: [] })
    ).rejects.toThrow(/key|signature/i)

    const other = nacl.sign.keyPair()
    await expect(
      loadSshRelayPackagedManifest({
        ...loadOptions(resourcesPath),
        acceptedKeys: [
          { keyId: sshRelayManifestKeyId(other.publicKey), publicKey: other.publicKey }
        ]
      })
    ).rejects.toThrow(/unknown signing key/i)
    await expect(
      loadSshRelayPackagedManifest({
        ...loadOptions(resourcesPath),
        acceptedKeys: [{ keyId: acceptedKey.keyId, publicKey: other.publicKey }]
      })
    ).rejects.toThrow(/key id/i)

    const invalid = signedManifest()
    invalid.signatures[0].signature = Buffer.alloc(64, 1).toString('base64')
    await writeManifest(resourcesPath, invalid)
    await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(
      /invalid.*signature/i
    )
  })

  it('rejects signed tag, version, channel, and protocol drift from the desktop', async () => {
    const resourcesPath = await resourcesRoot()
    for (const manifest of [
      signedManifest({ version: '1.4.141-rc.1' }),
      signedManifest({ version: '1.4.140', channel: 'stable' }),
      signedManifest({ relayProtocolVersion: 2 })
    ]) {
      await writeManifest(resourcesPath, manifest)
      await expect(loadSshRelayPackagedManifest(loadOptions(resourcesPath))).rejects.toThrow(
        /build|identity|protocol|release tag/i
      )
    }
  })
})
