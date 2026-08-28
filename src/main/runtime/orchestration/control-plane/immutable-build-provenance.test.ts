import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readEmbeddedBuildProvenance,
  computeRuntimeArtifactIdentity,
  resolveRuntimeBuildIdentity,
  resolveRuntimeCommitSha,
  type EmbeddedBuildProvenance
} from './runtime-build-identity'

function writeArtifact(
  root: string,
  files: Record<string, string>
): { entryPath: string; aggregateHash: string } {
  const records = Object.entries(files)
    .map(([path, value]) => {
      const absolute = join(root, path)
      mkdirSync(join(absolute, '..'), { recursive: true })
      writeFileSync(absolute, value)
      const bytes = Buffer.from(value)
      return {
        path,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const aggregateHash = createHash('sha256')
    .update(records.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join(''))
    .digest('hex')
  writeFileSync(
    join(root, 'orca-artifact-manifest.json'),
    `${JSON.stringify({ schemaVersion: 2, aggregateHash, files: records })}\n`
  )
  return { entryPath: join(root, 'main', 'index.js'), aggregateHash }
}

/** IMMUTABLE_BUILD_PROVENANCE — a runtime that resolves its source identity
 *  from the checkout reports whatever commit the tree happens to be on. A build
 *  made at A therefore starts claiming B the moment someone checks out B, and
 *  every receipt bound to that is meaningless. Provenance is now folded into
 *  the bundle at build time, and the runtime prefers it.
 */
describe('IMMUTABLE_BUILD_PROVENANCE', () => {
  const holder = globalThis as { ORCA_BUILD_PROVENANCE?: string | null }
  const artifactRoots: string[] = []
  afterEach(() => {
    delete holder.ORCA_BUILD_PROVENANCE
    while (artifactRoots.length) {
      rmSync(artifactRoots.pop() as string, { recursive: true, force: true })
    }
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

  it('changes when a sibling emitted chunk changes while the entry stays byte-identical', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'orca-artifact-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'orca-artifact-b-'))
    artifactRoots.push(rootA, rootB)
    const artifactA = writeArtifact(rootA, {
      'main/index.js': 'require("./chunks/runtime.js")\n',
      'main/chunks/runtime.js': 'module.exports = 1\n'
    })
    const artifactB = writeArtifact(rootB, {
      'main/index.js': 'require("./chunks/runtime.js")\n',
      'main/chunks/runtime.js': 'module.exports = 2\n'
    })
    const a = computeRuntimeArtifactIdentity(artifactA.entryPath, artifactA.aggregateHash)
    const b = computeRuntimeArtifactIdentity(artifactB.entryPath, artifactB.aggregateHash)
    expect(a.verified).toBe(true)
    expect(b.verified).toBe(true)
    expect(a.buildHash).not.toBe(b.buildHash)
  })

  it('is stable for byte-identical emitted artifact sets', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'orca-artifact-same-a-'))
    const rootB = mkdtempSync(join(tmpdir(), 'orca-artifact-same-b-'))
    artifactRoots.push(rootA, rootB)
    const files = {
      'main/index.js': 'require("./chunks/runtime.js")\n',
      'main/chunks/runtime.js': 'module.exports = 1\n'
    }
    const artifactA = writeArtifact(rootA, files)
    const artifactB = writeArtifact(rootB, files)
    expect(computeRuntimeArtifactIdentity(artifactA.entryPath, artifactA.aggregateHash)).toEqual(
      computeRuntimeArtifactIdentity(artifactB.entryPath, artifactB.aggregateHash)
    )
  })

  it('fails closed when the manifest omits an executable artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-artifact-extra-'))
    artifactRoots.push(root)
    const artifact = writeArtifact(root, {
      'main/index.js': 'require("./chunks/runtime.js")\n'
    })
    mkdirSync(join(root, 'main', 'chunks'), { recursive: true })
    writeFileSync(join(root, 'main', 'chunks', 'runtime.js'), 'module.exports = 1\n')
    expect(
      computeRuntimeArtifactIdentity(artifact.entryPath, artifact.aggregateHash)
    ).toMatchObject({ verified: false })
  })

  it('rejects a regenerated adjacent manifest when the embedded authority did not change', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-artifact-regenerated-'))
    artifactRoots.push(root)
    const original = writeArtifact(root, {
      'main/index.js': 'require("./chunks/runtime.js")\n',
      'main/chunks/runtime.js': 'module.exports = 1\n'
    })
    writeFileSync(join(root, 'main/chunks/runtime.js'), 'module.exports = 2\n')
    const regenerated = writeArtifact(root, {
      'main/index.js': 'require("./chunks/runtime.js")\n',
      'main/chunks/runtime.js': 'module.exports = 2\n'
    })
    expect(
      computeRuntimeArtifactIdentity(regenerated.entryPath, original.aggregateHash)
    ).toMatchObject({ verified: false })
  })
})

/** The embedded path refuses to name a commit for a dirty build. The checkout
 *  fallback used to name one anyway, which made it the softer way in: a dev
 *  runtime with local edits, or a stale bundle in a repo whose HEAD had moved,
 *  could stamp evidence with a commit the executing code never came from. */
describe('THE CHECKOUT FALLBACK MUST NOT NAME A COMMIT IT DOES NOT MATCH', () => {
  const trees: string[] = []
  afterEach(() => {
    while (trees.length) {
      rmSync(trees.pop() as string, { recursive: true, force: true })
    }
  })

  function repo(): string {
    const path = mkdtempSync(join(tmpdir(), 'orca-fallback-'))
    trees.push(path)
    const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' })
    git(['init', '--quiet'])
    git(['config', 'user.email', 'fixture@orca.test'])
    git(['config', 'user.name', 'Fixture'])
    writeFileSync(join(path, 'entry.js'), '//\n')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'fixture'])
    return path
  }

  it('names the commit for a clean checkout', () => {
    expect(resolveRuntimeCommitSha(join(repo(), 'entry.js'))).toMatch(/^[0-9a-f]{40}$/)
  })

  it('names NO commit once the tree is dirty', () => {
    const path = repo()
    writeFileSync(join(path, 'entry.js'), '// edited\n')
    expect(resolveRuntimeCommitSha(join(path, 'entry.js'))).toBeNull()
  })

  it('names no commit when an untracked file could have been compiled in', () => {
    const path = repo()
    writeFileSync(join(path, 'extra.js'), 'export default 1\n')
    expect(resolveRuntimeCommitSha(join(path, 'entry.js'))).toBeNull()
  })

  it('names no commit with no repository above it', () => {
    const bare = mkdtempSync(join(tmpdir(), 'orca-norepo-'))
    trees.push(bare)
    expect(resolveRuntimeCommitSha(join(bare, 'entry.js'))).toBeNull()
  })
})
