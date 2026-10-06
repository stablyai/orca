import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePath = 'src/main/ai-vault-search/session-search-index-writer.ts'
const baseline = '243f4431557471daa05636aed1a30be790485eda'
const before = execFileSync('git', ['show', `${baseline}:${sourcePath}`], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024
})
const after = readFileSync(join(root, sourcePath), 'utf8')

async function run(version, source) {
  const built = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { SessionSearchIndexWriter } from './${sourcePath}';
export { openSessionSearchDatabase } from './src/main/ai-vault-search/session-search-schema.ts';`,
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    plugins: [
      {
        name: 'select-writer-version',
        setup(bundler) {
          bundler.onLoad({ filter: /session-search-index-writer\.ts$/ }, () => ({
            contents: source,
            loader: 'ts'
          }))
        }
      }
    ]
  })
  const compiled = new Module(join(root, 'session-search-write-fence-probe.cjs'))
  compiled.filename = join(root, 'session-search-write-fence-probe.cjs')
  compiled.paths = Module._nodeModulePaths(root)
  compiled._compile(built.outputFiles[0].text, compiled.filename)
  const db = compiled.exports.openSessionSearchDatabase(':memory:')
  const writer = new compiled.exports.SessionSearchIndexWriter(db)
  const candidate = (path) => ({
    agent: 'claude',
    codexHome: null,
    file: { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString(), sizeBytes: 1 }
  })
  const outcome = { session: null, byteOffset: 1, incomplete: false }
  const tracked = version === 'before' ? writer.removals : writer.activeWrites
  assert.ok(tracked instanceof Map)
  try {
    for (let index = 0; index < 1000; index++) {
      const path = join('synthetic', `retired-${index}.jsonl`)
      const write = writer.beginWrite(candidate(path), 'replace', 0)
      assert.equal(write.commit(outcome), true)
      writer.removeFile(path)
    }
    const retainedPathsAfterRetirement = tracked.size
    const remainingFiles = db.prepare('SELECT count(*) AS count FROM files').get().count
    assert.equal(retainedPathsAfterRetirement, version === 'before' ? 1000 : 0)
    assert.equal(remainingFiles, 0)
    const removed = join('synthetic', 'never-indexed.jsonl')
    const stale = writer.beginWrite(candidate(removed), 'replace', 0)
    writer.removeFile(removed)
    const staleCommitAccepted = stale.commit(outcome)
    assert.equal(staleCommitAccepted, false)
    assert.equal(db.prepare('SELECT count(*) AS count FROM files').get().count, 0)
    return {
      source: version === 'before' ? baseline : 'working tree',
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      retiredFiles: 1000,
      remainingFiles,
      retainedPathsAfterRetirement,
      neverIndexedStaleCommitAccepted: staleCommitAccepted
    }
  } finally {
    writer.close?.()
    db.close()
  }
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      sourcePath,
      database: 'Production schema and adapter with an in-memory SQLite database',
      before: await run('before', before),
      after: await run('after', after)
    },
    null,
    2
  )
)
