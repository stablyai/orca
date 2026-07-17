import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import { parseSshRelayCompiledManifestTrust } from './ssh-relay-compiled-manifest-trust'
import type * as CompiledManifestTrustModule from './ssh-relay-compiled-manifest-trust'
import {
  loadSshRelayOfficialManifest,
  type SshRelayOfficialManifestLoadOptions
} from './ssh-relay-official-manifest'
import { sshRelayPackagedManifestPath } from './ssh-relay-packaged-manifest'
import { signSshRelayArtifactManifest, sshRelayManifestKeyId } from './ssh-relay-manifest-signature'

const trustMocks = vi.hoisted(() => ({ load: vi.fn() }))

vi.mock('./ssh-relay-compiled-manifest-trust', async (importOriginal) => {
  const actual = await importOriginal<typeof CompiledManifestTrustModule>()
  return { ...actual, loadSshRelayCompiledManifestTrust: trustMocks.load }
})

const temporaryDirectories: string[] = []
const trustedKeyPair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index)
)
const untrustedKeyPair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => 31 - index)
)

function compiledTrust() {
  return parseSshRelayCompiledManifestTrust({
    schemaVersion: 1,
    keys: [
      {
        keyId: sshRelayManifestKeyId(trustedKeyPair.publicKey),
        publicKeyBase64: Buffer.from(trustedKeyPair.publicKey).toString('base64')
      }
    ]
  })
}

function signedManifest(keyPair = trustedKeyPair) {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.build = {
    tag: 'v1.4.140-rc.1',
    version: '1.4.140-rc.1',
    channel: 'rc',
    relayProtocolVersion: 1
  }
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  return manifest
}

async function resourcesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-official-manifest-'))
  temporaryDirectories.push(root)
  return join(root, 'Resources')
}

async function writeManifest(resourcesPath: string, value: unknown): Promise<void> {
  await mkdir(join(resourcesPath, 'ssh-relay-runtime'), { recursive: true })
  await writeFile(sshRelayPackagedManifestPath(resourcesPath), JSON.stringify(value))
}

function loadOptions(resourcesPath: string): SshRelayOfficialManifestLoadOptions {
  return {
    packaged: true,
    resourcesPath,
    appVersion: '1.4.140-rc.1',
    relayProtocolVersion: 1
  }
}

afterEach(async () => {
  trustMocks.load.mockReset()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay official manifest', () => {
  it('returns unavailable without inspecting resources when compiled trust is absent', async () => {
    trustMocks.load.mockReturnValue(null)
    const resourcesPath = join(tmpdir(), 'missing-orca-relay-resources')

    await expect(loadSshRelayOfficialManifest(loadOptions(resourcesPath))).resolves.toBeNull()
    expect(trustMocks.load).toHaveBeenCalledTimes(1)
  })

  it('binds a verified packaged manifest to the compiled accepted-key fingerprint', async () => {
    const resourcesPath = await resourcesRoot()
    const trust = compiledTrust()
    trustMocks.load.mockReturnValue(trust)
    await writeManifest(resourcesPath, signedManifest())

    const result = await loadSshRelayOfficialManifest(loadOptions(resourcesPath))

    expect(result).toMatchObject({
      acceptedKeysSha256: trust?.acceptedKeysSha256,
      manifest: { build: { tag: 'v1.4.140-rc.1', relayProtocolVersion: 1 } }
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result?.manifest)).toBe(true)
  })

  it('cannot be redirected to caller-supplied accepted keys', async () => {
    const resourcesPath = await resourcesRoot()
    trustMocks.load.mockReturnValue(compiledTrust())
    await writeManifest(resourcesPath, signedManifest(untrustedKeyPair))
    const hostileOptions = {
      ...loadOptions(resourcesPath),
      acceptedKeys: [
        {
          keyId: sshRelayManifestKeyId(untrustedKeyPair.publicKey),
          publicKey: untrustedKeyPair.publicKey
        }
      ]
    } as SshRelayOfficialManifestLoadOptions

    await expect(loadSshRelayOfficialManifest(hostileOptions)).rejects.toThrow(
      /unknown signing key/i
    )
  })

  it('propagates packaged-resource and official-build failures closed', async () => {
    const resourcesPath = await resourcesRoot()
    trustMocks.load.mockReturnValue(compiledTrust())
    await mkdir(join(resourcesPath, 'ssh-relay-runtime'), { recursive: true })
    await writeFile(sshRelayPackagedManifestPath(resourcesPath), '{malformed manifest shape')

    await expect(loadSshRelayOfficialManifest(loadOptions(resourcesPath))).rejects.toThrow(
      /manifest|schema|field/i
    )
    await expect(
      loadSshRelayOfficialManifest({ ...loadOptions(resourcesPath), packaged: false })
    ).rejects.toThrow(/packaged/i)
  })
})
