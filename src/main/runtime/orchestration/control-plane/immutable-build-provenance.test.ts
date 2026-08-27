import { afterEach, describe, expect, it } from 'vitest'
import {
  readEmbeddedBuildProvenance,
  resolveRuntimeBuildIdentity,
  type EmbeddedBuildProvenance
} from './runtime-build-identity'

/** IMMUTABLE_BUILD_PROVENANCE — a runtime that resolves its source identity
 *  from the checkout reports whatever commit the tree happens to be on. A build
 *  made at A therefore starts claiming B the moment someone checks out B, and
 *  every receipt bound to that is meaningless. Provenance is now folded into
 *  the bundle at build time, and the runtime prefers it.
 */
describe('IMMUTABLE_BUILD_PROVENANCE', () => {
  const holder = globalThis as { ORCA_BUILD_PROVENANCE?: string | null }
  afterEach(() => {
    delete holder.ORCA_BUILD_PROVENANCE
  })

  const SHA_A = 'a'.repeat(40)

  function embed(record: Partial<EmbeddedBuildProvenance>) {
    holder.ORCA_BUILD_PROVENANCE = JSON.stringify({
      schemaVersion: 1,
      sourceSha: SHA_A,
      dirty: false,
      appVersion: '1.2.3',
      builtAt: '2026-08-27T00:00:00.000Z',
      ...record
    })
  }

  it('reports the commit it was BUILT from, not the one the checkout moved to', () => {
    embed({ sourceSha: SHA_A })
    const identity = resolveRuntimeBuildIdentity(__filename)
    // The working tree this test runs in is on a completely different commit.
    expect(identity.commitSha).toBe(SHA_A)
    expect(identity.provenanceSource).toBe('embedded')
    expect(identity.id).toContain(SHA_A)
  })

  it('makes evidence for build A stale under build B', () => {
    embed({ sourceSha: SHA_A })
    const a = resolveRuntimeBuildIdentity(__filename).id
    embed({ sourceSha: 'b'.repeat(40) })
    const b = resolveRuntimeBuildIdentity(__filename).id
    expect(a).not.toBe(b)
  })

  it('refuses to name a commit for a dirty build, because it matches none', () => {
    embed({ dirty: true, sourceSha: SHA_A })
    const identity = resolveRuntimeBuildIdentity(__filename)
    expect(identity.commitSha).toBeNull()
    expect(identity.dirtyBuild).toBe(true)
    expect(identity.id).toContain('dirty')
  })

  it('is honest when a build has no repository above it', () => {
    embed({ sourceSha: null, dirty: null })
    const identity = resolveRuntimeBuildIdentity(__filename)
    expect(identity.commitSha).toBeNull()
    expect(identity.provenanceSource).toBe('embedded')
  })

  it('falls back to the checkout only when nothing was embedded, and says so', () => {
    delete holder.ORCA_BUILD_PROVENANCE
    expect(readEmbeddedBuildProvenance()).toBeNull()
    const identity = resolveRuntimeBuildIdentity(__filename)
    expect(identity.provenanceSource).not.toBe('embedded')
  })

  it('changes with any bundled module, not only the entry, because the hash covers the bundle', () => {
    embed({ sourceSha: SHA_A })
    const fromThisFile = resolveRuntimeBuildIdentity(__filename).buildHash
    const fromAnother = resolveRuntimeBuildIdentity(
      __filename.replace('immutable-build-provenance.test.ts', 'runtime-build-identity.ts')
    ).buildHash
    // Different bundled content yields a different build hash.
    expect(fromThisFile).not.toBe(fromAnother)
  })
})
