const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load, loadSources, readText, sha, versions: sourceVersions } = require('./sources.cjs')
const { inputs, heap, makeOwner, behavior } = require('./scenario.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc')

async function main() {
  const reports = []
  const versions = []
  for (const variant of ['baseline', 'candidate-buffer', 'candidate-fallback']) {
    const fixed = variant !== 'baseline'
    const loaded = await load(fixed)
    loaded.api.resetOwnRetainedStringCopier()
    const originalBuffer = globalThis.Buffer
    try {
      if (variant === 'candidate-fallback') {
        globalThis.Buffer = undefined
      }
      assert.equal(
        loaded.api.ownRetainedString('prefix-\ud800a\udfff\u0000漢-suffix'),
        'prefix-\ud800a\udfff\u0000漢-suffix'
      )
    } finally {
      globalThis.Buffer = originalBuffer
    }
    const controls = behavior(loaded.api)
    versions.push({
      variant,
      fixed,
      sourceSha256: loaded.sourceSha256,
      bundleSha256: loaded.bundleSha256,
      evaluatedSources: loaded.evaluatedSources,
      callerSourceHashes: loaded.callerSourceHashes,
      controls
    })
    for (const ownerKind of ['scanner', 'title-tracker', 'background-relay']) {
      for (const input of inputs) {
        for (const [chars, count] of [
          [64 * 1024, 32],
          [1024 * 1024, 8]
        ]) {
          const before = await heap()
          const owners = Array.from({ length: count }, (_, index) =>
            makeOwner(loaded.api, ownerKind, input, chars, index)
          )
          const retainedDelta = (await heap()) - before
          const expectParent = !fixed && input.retained
          assert.ok(
            expectParent ? retainedDelta > chars * count * 0.75 : retainedDelta < 1024 * 1024,
            JSON.stringify({ fixed, ownerKind, input: input.name, retainedDelta })
          )
          for (const owner of owners) {
            owner.complete()
          }
          const completedDelta = (await heap()) - before
          assert.ok(
            completedDelta < 1024 * 1024,
            JSON.stringify({ fixed, ownerKind, input: input.name, completedDelta })
          )
          for (const owner of owners) {
            owner.release()
          }
          reports.push({
            variant,
            fixed,
            ownerKind,
            input: input.name,
            inputCodeUnits: chars,
            owners: count,
            inputSuffixCodeUnits: input.suffix.length,
            retainedDelta,
            completedDelta
          })
        }
      }
      const input = inputs[0]
      const before = await heap()
      const owners = Array.from({ length: 8 }, (_, index) =>
        makeOwner(loaded.api, ownerKind, input, 1024 * 1024, index)
      )
      for (const owner of owners) {
        owner.release()
      }
      const resetDelta = (await heap()) - before
      assert.ok(resetDelta < 1024 * 1024, JSON.stringify({ fixed, ownerKind, resetDelta }))
      reports.push({ variant, fixed, ownerKind, input: 'reset-without-completion', resetDelta })
    }
  }
  assert.deepEqual(versions[0].controls, versions[1].controls)
  assert.deepEqual(versions[0].controls, versions[2].controls)
  let crlfReads = 0
  const crlfSources = loadSources((file) => {
    crlfReads += 1
    return readText(file).replaceAll('\n', '\r\n')
  })
  assert.deepEqual(crlfSources, loadSources())
  assert.equal(crlfReads, 2)
  const artifacts = [
    'sources.cjs',
    'scenario.cjs',
    'reproduce.cjs',
    'source-versions.json',
    'fix.patch',
    'before.config.mjs'
  ]
  const artifactHashes = Object.fromEntries(
    artifacts.map((file) => [file, sha(readText(path.join(__dirname, file)))])
  )
  const result = {
    scope:
      'Actual-source bounded diagnostic; captured fish sequence syntax with synthetic large-prefix placement and chunk split. No affected-host, RSS, native PTY, or whole-release claim.',
    node: process.version,
    electron: process.versions.electron ?? null,
    v8: process.versions.v8,
    sourcePath: sourceVersions.sourcePath,
    crlfReads,
    artifactHashes,
    versions,
    reports
  }
  const resultPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(
        __dirname,
        process.versions.electron ? 'electron-results.json' : 'node-results.json'
      )
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    JSON.stringify({ resultPath, cases: reports.length, variants: versions.map((x) => x.variant) })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture deadline')
  process.exit(2)
}, 60000).unref()
