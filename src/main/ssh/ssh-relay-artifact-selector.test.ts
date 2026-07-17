import nacl from 'tweetnacl'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createSshRelayArtifactTestManifest,
  createSshRelayDarwinArtifactTestManifest,
  createSshRelayWindowsArtifactTestManifest
} from './ssh-relay-artifact-test-manifest'
import { parseSshRelayArtifactManifest } from './ssh-relay-artifact-schema'
import { selectSshRelayArtifact } from './ssh-relay-artifact-selector'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'

const compatibleLinuxHost = {
  os: 'linux' as const,
  architecture: 'x64' as const,
  processTranslated: false,
  kernelVersion: '6.8.0',
  libc: { family: 'glibc' as const, version: '2.39' },
  libstdcxxVersion: '6.0.33',
  glibcxxVersion: '3.4.33'
}

const manifestKeyPair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index)
)

function verifiedManifest(manifest = createSshRelayArtifactTestManifest()) {
  manifest.signatures = [signSshRelayArtifactManifest(manifest, manifestKeyPair.secretKey)]
  return verifySshRelayArtifactManifest(manifest, [
    {
      keyId: sshRelayManifestKeyId(manifestKeyPair.publicKey),
      publicKey: manifestKeyPair.publicKey
    }
  ])
}

function windowsManifest({
  architecture = 'x64',
  minimumBuild = architecture === 'x64' ? 19045 : 26100
}: {
  architecture?: 'x64' | 'arm64'
  minimumBuild?: number
} = {}) {
  return createSshRelayWindowsArtifactTestManifest({ architecture, minimumBuild })
}

const compatibleWindowsHost = {
  os: 'win32' as const,
  architecture: 'x64' as const,
  processTranslated: false,
  build: 19045,
  openSshVersion: '8.1p1',
  powerShellVersion: '5.1',
  dotNetFrameworkRelease: 528040
}

describe('SSH relay artifact selector', () => {
  it('requires a signature-verified manifest type', () => {
    expectTypeOf(createSshRelayArtifactTestManifest()).not.toMatchTypeOf<
      Parameters<typeof selectSshRelayArtifact>[0]
    >()
  })

  it('selects the single compatible glibc tuple', () => {
    const manifest = verifiedManifest()
    const result = selectSshRelayArtifact(manifest, compatibleLinuxHost)

    expect(result).toMatchObject({
      kind: 'selected',
      tupleId: 'linux-x64-glibc',
      contentId: manifest.tuples[0].contentId,
      releaseTag: 'v1.4.140-rc.1',
      archive: {
        name: manifest.tuples[0].archive.name,
        sha256: manifest.tuples[0].archive.sha256,
        downloadUrl: `https://github.com/stablyai/orca/releases/download/v1.4.140-rc.1/${manifest.tuples[0].archive.name}`
      }
    })
    expect(JSON.stringify(result)).not.toContain('latest')
    expect(() => {
      if (result.kind === 'selected') {
        Object.defineProperty(result.archive, 'downloadUrl', { value: 'https://example.com' })
      }
    }).toThrow(TypeError)
  })

  it('accepts every Linux compatibility value at its exact minimum', () => {
    expect(
      selectSshRelayArtifact(verifiedManifest(), {
        ...compatibleLinuxHost,
        kernelVersion: '4.18',
        libc: { family: 'glibc', version: '2.28' },
        libstdcxxVersion: '6.0.25',
        glibcxxVersion: '3.4.25'
      }).kind
    ).toBe('selected')
  })

  it.each(['4.18.0-553.5.1.el8_10.x86_64', '5.15.0-107-generic', '6.6.15-0-lts'])(
    'accepts a supported Linux distro kernel release %s',
    (kernelVersion) => {
      expect(
        selectSshRelayArtifact(verifiedManifest(), {
          ...compatibleLinuxHost,
          kernelVersion
        }).kind
      ).toBe('selected')
    }
  )

  it.each([
    ['4.18.0-553.5.1.el8_10.x86_64', 'selected'],
    ['4.17.99-553.5.1.el8_10.x86_64', 'kernel-too-old'],
    ['4.18.0 bad', 'unknown-kernel'],
    ['4.18.0/bad', 'unknown-kernel'],
    ['4.18.0:bad', 'unknown-kernel'],
    ['4.18.0@bad', 'unknown-kernel']
  ] as const)('classifies the kernel suffix boundary for %s', (kernelVersion, expected) => {
    const result = selectSshRelayArtifact(verifiedManifest(), {
      ...compatibleLinuxHost,
      kernelVersion
    })

    expect(result.kind === 'selected' ? result.kind : result.reason).toBe(expected)
  })

  it('keeps non-kernel version grammars strict', () => {
    expect(
      selectSshRelayArtifact(verifiedManifest(), {
        ...compatibleLinuxHost,
        libc: { family: 'glibc', version: '2.28_bad' }
      })
    ).toEqual({ kind: 'legacy', reason: 'unknown-libc' })
    expect(
      selectSshRelayArtifact(verifiedManifest(createSshRelayDarwinArtifactTestManifest()), {
        os: 'darwin',
        architecture: 'arm64',
        processTranslated: false,
        version: '13.5_bad'
      })
    ).toEqual({ kind: 'legacy', reason: 'unknown-os-version' })
    expect(
      selectSshRelayArtifact(verifiedManifest(windowsManifest()), {
        ...compatibleWindowsHost,
        powerShellVersion: '5.1_bad'
      })
    ).toEqual({ kind: 'legacy', reason: 'unknown-powershell' })
  })

  it('selects the detected libc family when both Linux variants exist', () => {
    const manifest = createSshRelayArtifactTestManifest()
    const musl = structuredClone(manifest.tuples[0])
    musl.tupleId = 'linux-x64-musl'
    musl.compatibility = {
      kind: 'linux',
      minimumKernelVersion: '4.18',
      libc: {
        family: 'musl',
        minimumVersion: '1.2.5',
        minimumLibstdcxxVersion: null,
        minimumGlibcxxVersion: null
      }
    }
    for (const entry of musl.entries) {
      entry.path = entry.path.replace('watcher-linux-x64-glibc', 'watcher-linux-x64-musl')
    }
    for (const attestation of musl.nativeVerification.files) {
      attestation.path = attestation.path.replace(
        'watcher-linux-x64-glibc',
        'watcher-linux-x64-musl'
      )
    }
    musl.contentId = computeSshRelayRuntimeContentId(musl)
    musl.archive.name = sshRelayRuntimeArchiveName(musl.tupleId, musl.contentId)
    manifest.tuples.push(musl)
    const parsed = parseSshRelayArtifactManifest(manifest)
    const verified = verifiedManifest(parsed)

    expect(selectSshRelayArtifact(verified, compatibleLinuxHost)).toMatchObject({
      kind: 'selected',
      tupleId: 'linux-x64-glibc'
    })
    expect(
      selectSshRelayArtifact(verified, {
        ...compatibleLinuxHost,
        libc: { family: 'musl', version: '1.2.5' }
      })
    ).toMatchObject({ kind: 'selected', tupleId: 'linux-x64-musl' })
  })

  it.each([
    [{ ...compatibleLinuxHost, kernelVersion: '4.17' }, 'kernel-too-old'],
    [
      { ...compatibleLinuxHost, libc: { family: 'glibc' as const, version: '2.27' } },
      'libc-too-old'
    ],
    [{ ...compatibleLinuxHost, glibcxxVersion: '3.4.24' }, 'libstdcxx-too-old'],
    [{ ...compatibleLinuxHost, libstdcxxVersion: undefined }, 'unknown-libstdcxx'],
    [{ ...compatibleLinuxHost, kernelVersion: 'not-a-version' }, 'unknown-kernel'],
    [{ ...compatibleLinuxHost, libc: { family: 'unknown' as const } }, 'unknown-libc'],
    [
      { ...compatibleLinuxHost, libc: { family: 'musl' as const, version: '1.2.5' } },
      'tuple-unavailable'
    ],
    [{ ...compatibleLinuxHost, processTranslated: true }, 'translated-process'],
    [{ ...compatibleLinuxHost, architecture: 'arm64' as const }, 'tuple-unavailable']
  ])('selects legacy for incompatible or unknown host evidence', (host, reason) => {
    expect(selectSshRelayArtifact(verifiedManifest(), host)).toEqual({
      kind: 'legacy',
      reason
    })
  })

  it('checks Windows bootstrap versions before selection', () => {
    const manifest = verifiedManifest(windowsManifest())
    expect(selectSshRelayArtifact(manifest, compatibleWindowsHost).kind).toBe('selected')
    expect(selectSshRelayArtifact(manifest, { ...compatibleWindowsHost, build: 19044 })).toEqual({
      kind: 'legacy',
      reason: 'os-too-old'
    })
    expect(
      selectSshRelayArtifact(manifest, {
        ...compatibleWindowsHost,
        openSshVersion: '8.0p1'
      })
    ).toEqual({ kind: 'legacy', reason: 'openssh-too-old' })
    expect(
      selectSshRelayArtifact(manifest, {
        ...compatibleWindowsHost,
        powerShellVersion: '5.0'
      })
    ).toEqual({ kind: 'legacy', reason: 'powershell-too-old' })
    expect(
      selectSshRelayArtifact(manifest, {
        ...compatibleWindowsHost,
        dotNetFrameworkRelease: 528039
      })
    ).toEqual({ kind: 'legacy', reason: 'dotnet-too-old' })
  })

  it.each([
    ['x64', 19044, 19045],
    ['arm64', 26099, 26100]
  ] as const)(
    'enforces the reviewed Windows %s build boundary',
    (architecture, rejectedBuild, acceptedBuild) => {
      const manifest = verifiedManifest(windowsManifest({ architecture }))
      const host = { ...compatibleWindowsHost, architecture }

      expect(selectSshRelayArtifact(manifest, { ...host, build: rejectedBuild })).toEqual({
        kind: 'legacy',
        reason: 'os-too-old'
      })
      expect(selectSshRelayArtifact(manifest, { ...host, build: acceptedBuild }).kind).toBe(
        'selected'
      )
    }
  )

  it('selects legacy when Windows bootstrap evidence is absent or malformed', () => {
    const manifest = verifiedManifest(windowsManifest())
    expect(
      selectSshRelayArtifact(manifest, { ...compatibleWindowsHost, openSshVersion: '8.1.0' })
    ).toEqual({ kind: 'legacy', reason: 'unknown-openssh' })
    expect(
      selectSshRelayArtifact(manifest, { ...compatibleWindowsHost, powerShellVersion: undefined })
    ).toEqual({ kind: 'legacy', reason: 'unknown-powershell' })
    expect(
      selectSshRelayArtifact(manifest, {
        ...compatibleWindowsHost,
        dotNetFrameworkRelease: undefined
      })
    ).toEqual({ kind: 'legacy', reason: 'unknown-dotnet' })
  })

  it('checks the minimum macOS version before selection', () => {
    const manifest = createSshRelayDarwinArtifactTestManifest()

    expect(
      selectSshRelayArtifact(verifiedManifest(manifest), {
        os: 'darwin',
        architecture: 'arm64',
        processTranslated: false,
        version: '13.4'
      })
    ).toEqual({ kind: 'legacy', reason: 'os-too-old' })
  })
})
