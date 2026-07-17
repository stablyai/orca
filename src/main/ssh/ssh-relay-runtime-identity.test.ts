import { describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity'

function changedEntryContentId(role: string): string {
  const tuple = structuredClone(createSshRelayArtifactTestManifest().tuples[0])
  const entry = tuple.entries.find(
    (candidate) => candidate.type === 'file' && candidate.role === role
  )
  if (!entry || entry.type !== 'file') {
    throw new Error(`test fixture missing ${role}`)
  }
  entry.sha256 = `sha256:${'f'.repeat(64)}`
  return computeSshRelayRuntimeContentId(tuple)
}

describe('SSH relay runtime content identity', () => {
  it('matches a fixed canonical test vector', () => {
    const tuple = createSshRelayArtifactTestManifest().tuples[0]

    expect(computeSshRelayRuntimeContentId(tuple)).toBe(
      'sha256:5afe9c8094ec61a5eec6f7be6d1035faacee7362871985c74cc6ee6aceea8677'
    )
  })

  it.each(['node', 'node-pty-native', 'parcel-watcher-native', 'relay-watcher'])(
    'changes when only %s bytes change',
    (role) => {
      const tuple = createSshRelayArtifactTestManifest().tuples[0]
      expect(changedEntryContentId(role)).not.toBe(computeSshRelayRuntimeContentId(tuple))
    }
  )

  it('changes when an executable mode changes', () => {
    const tuple = structuredClone(createSshRelayArtifactTestManifest().tuples[0])
    const node = tuple.entries.find((entry) => entry.type === 'file' && entry.role === 'node')
    if (!node || node.type !== 'file') {
      throw new Error('test fixture missing node')
    }
    node.mode = 0o644

    expect(computeSshRelayRuntimeContentId(tuple)).not.toBe(
      createSshRelayArtifactTestManifest().tuples[0].contentId
    )
  })

  it('is independent of entry ordering and release metadata', () => {
    const manifest = createSshRelayArtifactTestManifest()
    const tuple = structuredClone(manifest.tuples[0])
    tuple.entries.reverse()
    tuple.archive.name = 'ignored-by-runtime-identity.tar.br'
    tuple.archive.sha256 = `sha256:${'f'.repeat(64)}`
    tuple.metadataAssets.sbom.sha256 = `sha256:${'e'.repeat(64)}`
    tuple.nativeVerification.verifiedAt = '2030-01-01T00:00:00.000Z'

    expect(computeSshRelayRuntimeContentId(tuple)).toBe(manifest.tuples[0].contentId)
  })
})
