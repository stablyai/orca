import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARTIFACT_AGGREGATE_PLACEHOLDER,
  buildProvenanceLiteral,
  readBuildProvenance,
  writeBuildArtifactManifest
} from './build-provenance.mjs'

/** BUNDLER_SCRATCH_FILE_MAKES_EVERY_BUILD_DIRTY — vite writes its own
 *  `electron.vite.config.<timestamp>.mjs` into the repo root BEFORE evaluating
 *  the config, so provenance measured from inside the config always read the
 *  tree as dirty. A dirty build names no commit, so `commitSha` was
 *  unconditionally null and nothing could ever be certified against a SHA.
 *
 *  The fix is ordering, not leniency: the build wrapper measures the tree first
 *  and hands the result down, so the strict "any change is dirty" rule stays.
 */
describe('BUNDLER_SCRATCH_FILE_MAKES_EVERY_BUILD_DIRTY', () => {
  const trees = []
  afterEach(() => {
    delete process.env.ORCA_BUILD_PROVENANCE_JSON
    while (trees.length) {
      rmSync(trees.pop(), { recursive: true, force: true })
    }
  })

  function repo() {
    const path = mkdtempSync(join(tmpdir(), 'orca-provenance-'))
    trees.push(path)
    const git = (args) => execFileSync('git', args, { cwd: path, encoding: 'utf8' })
    git(['init', '--quiet'])
    git(['config', 'user.email', 'fixture@orca.test'])
    git(['config', 'user.name', 'Fixture'])
    writeFileSync(join(path, 'package.json'), JSON.stringify({ version: '9.9.9' }))
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'fixture'])
    return path
  }

  it('reports a clean tree as clean', () => {
    expect(readBuildProvenance(repo())).toMatchObject({ dirty: false, appVersion: '9.9.9' })
  })

  it('still calls the tree dirty when a scratch file is written after measuring', () => {
    const path = repo()
    const handed = JSON.stringify(readBuildProvenance(path))
    // Vite drops its config bundle here at exactly this point.
    writeFileSync(join(path, 'electron.vite.config.1787869530677.mjs'), 'export default {}')
    // Measured now, the tree reads dirty — this is the trap.
    expect(readBuildProvenance(path).dirty).toBe(true)
    // Handed down from before it, the artifact still names its commit.
    process.env.ORCA_BUILD_PROVENANCE_JSON = handed
    expect(JSON.parse(JSON.parse(buildProvenanceLiteral(path)))).toMatchObject({ dirty: false })
  })

  it('does not let a handed-down value hide a genuinely dirty tree', () => {
    const path = repo()
    writeFileSync(join(path, 'package.json'), JSON.stringify({ version: '9.9.9', changed: true }))
    process.env.ORCA_BUILD_PROVENANCE_JSON = JSON.stringify(readBuildProvenance(path))
    expect(() => buildProvenanceLiteral(path)).toThrow(/clean exact-SHA/)
  })

  it('fails closed when a caller hands the build an unusable provenance record', () => {
    const path = repo()
    process.env.ORCA_BUILD_PROVENANCE_JSON = 'not json'
    expect(() => buildProvenanceLiteral(path)).toThrow(/valid JSON/)
    process.env.ORCA_BUILD_PROVENANCE_JSON = JSON.stringify({ schemaVersion: 99 })
    expect(() => buildProvenanceLiteral(path)).toThrow(/clean exact-SHA/)
  })

  it('rejects a forged clean SHA even when the record shape is valid', () => {
    const path = repo()
    const forged = readBuildProvenance(path)
    process.env.ORCA_BUILD_PROVENANCE_JSON = JSON.stringify({
      ...forged,
      sourceSha: 'f'.repeat(40)
    })
    expect(() => buildProvenanceLiteral(path)).toThrow(/does not match/)
  })

  it('names no commit when there is no repository above the build', () => {
    const bare = mkdtempSync(join(tmpdir(), 'orca-norepo-'))
    trees.push(bare)
    expect(readBuildProvenance(bare)).toMatchObject({ sourceSha: null, dirty: null })
  })

  it('rechecks source after compilation and seals the full artifact authority', () => {
    const path = repo()
    const provenance = JSON.stringify(readBuildProvenance(path))
    mkdirSync(join(path, 'out/main'), { recursive: true })
    writeFileSync(
      join(path, 'out/main/index.js'),
      `globalThis.provenance=${JSON.stringify(provenance)};${ARTIFACT_AGGREGATE_PLACEHOLDER}`
    )
    writeFileSync(join(path, 'out/main/chunk.js'), 'export const value = 1\n')
    const manifest = writeBuildArtifactManifest(path, provenance)
    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.aggregateHash).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(path, 'out/main/index.js'), 'utf8')).toContain(manifest.aggregateHash)
    expect(readFileSync(join(path, 'out/main/index.js'), 'utf8')).not.toContain(
      ARTIFACT_AGGREGATE_PLACEHOLDER
    )
  })

  it('refuses to seal when tracked source moved during compilation', () => {
    const path = repo()
    const provenance = JSON.stringify(readBuildProvenance(path))
    mkdirSync(join(path, 'out/main'), { recursive: true })
    writeFileSync(join(path, 'out/main/index.js'), ARTIFACT_AGGREGATE_PLACEHOLDER)
    writeFileSync(join(path, 'package.json'), JSON.stringify({ version: '9.9.9', changed: true }))
    expect(() => writeBuildArtifactManifest(path, provenance)).toThrow(/does not match/)
  })
})
