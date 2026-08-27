import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProvenanceLiteral, readBuildProvenance } from './build-provenance.mjs'

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
    expect(JSON.parse(JSON.parse(buildProvenanceLiteral(path)))).toMatchObject({ dirty: true })
  })

  it('measures the tree itself when handed something unusable', () => {
    const path = repo()
    process.env.ORCA_BUILD_PROVENANCE_JSON = 'not json'
    expect(JSON.parse(JSON.parse(buildProvenanceLiteral(path)))).toMatchObject({ dirty: false })
    process.env.ORCA_BUILD_PROVENANCE_JSON = JSON.stringify({ schemaVersion: 99 })
    expect(JSON.parse(JSON.parse(buildProvenanceLiteral(path)))).toMatchObject({
      schemaVersion: 1,
      dirty: false
    })
  })

  it('names no commit when there is no repository above the build', () => {
    const bare = mkdtempSync(join(tmpdir(), 'orca-norepo-'))
    trees.push(bare)
    expect(readBuildProvenance(bare)).toMatchObject({ sourceSha: null, dirty: null })
  })
})
