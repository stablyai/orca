const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { scenario } = require('./scenario.cjs')
const { loadSources, sha, versions } = require('./sources.cjs')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1', 'Run with ORCA_BACKGROUND_LAUNCH=1')

;(async () => {
  const canonical = loadSources()
  let crlfReads = 0
  const crlf = loadSources((file) => {
    crlfReads += 1
    return readFileSync(file, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
  })
  assert.deepEqual(crlf, canonical)
  assert.equal(crlfReads, 3)
  const phases = {}
  for (const phase of ['baseline', 'fixed', 'reported', 'reportedFixed']) {
    phases[phase] = await scenario(phase)
  }
  assert.deepEqual(phases.baseline.behavior, phases.fixed.behavior)
  assert.deepEqual(phases.reported.behavior, phases.reportedFixed.behavior)
  const artifactHashes = Object.fromEntries(
    [
      'sources.cjs',
      'scenario.cjs',
      'reproduce.cjs',
      'before.config.mjs',
      'source-versions.json',
      'fix.patch',
      'reported.patch'
    ].map((file) => [file, sha(readFileSync(path.join(__dirname, file)))])
  )
  const result = {
    runtime: process.versions,
    sourceVersions: versions.namedReferences,
    scope: versions.scope,
    crlfLoaderControl: { reads: crlfReads, equal: true },
    artifactHashes,
    phases,
    measurement:
      'Read-only closure observes private Map and chunk-array cardinalities in source overlay. No heap/RSS measurement, native process or affected-host inference.'
  }
  const output = process.argv[2] ?? path.join(__dirname, 'node-results.json')
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    JSON.stringify({
      output,
      phases: Object.fromEntries(
        Object.entries(phases).map(([phase, result]) => [
          phase,
          {
            samples: result.samples,
            scheduled: result.behavior.scheduled,
            published: result.behavior.published
          }
        ])
      ),
      behaviorEqual: true
    })
  )
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
