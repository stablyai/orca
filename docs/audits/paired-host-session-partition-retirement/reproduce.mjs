import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import sources from './sources.cjs'

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const { root, sha, versions, loadVariants } = sources
const artifact = import.meta.dirname
const loaded = loadVariants()
const mapHashes = (maps) =>
  Object.fromEntries(
    Object.entries(maps).map(([phase, files]) => [
      phase,
      Object.fromEntries(
        Object.entries(files).map(([file, source]) => [file, source === null ? null : sha(source)])
      )
    ])
  )
const expectedMaps = mapHashes(loaded.maps)
const reconstructedInputs = []
for (const phase of ['current-before', 'current-fixed', 'main-before', 'main-fixed']) {
  const reconstructed = loadVariants((file) => loaded.maps[phase][file])
  assert.deepEqual(mapHashes(reconstructed.maps), expectedMaps)
  reconstructedInputs.push(phase)
}
const crlf = loadVariants(
  (file) => loaded.maps['main-fixed'][file]?.replaceAll('\n', '\r\n') ?? null
)
assert.deepEqual(mapHashes(crlf.maps), expectedMaps)
const artifactHashes = {}
for (const file of [
  'scenario.test.mjs',
  'sources.cjs',
  'phase.config.mjs',
  'before.config.mjs',
  'reproduce.mjs',
  'source-versions.json',
  'fix.patch',
  'main-fix.patch',
  'publication.patch'
]) {
  artifactHashes[file] = sha(
    (await readFile(join(artifact, file), 'utf8')).replaceAll('\r\n', '\n')
  )
}
const scratch = await mkdtemp(join(tmpdir(), 'orca-paired-partition-retirement-'))
const require = createRequire(import.meta.url)
let runnerId
try {
  const runnerPath = join(scratch, 'run-process.cjs')
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'src/shared/child-process/run-process.ts')],
    outfile: runnerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    metafile: true,
    logLevel: 'silent'
  })
  const runnerSourceHashes = {}
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const file = relative(root, resolve(root, input)).replaceAll('\\', '/')
    assert.ok(versions.sources[file], `Unfenced runner dependency: ${file}`)
    const actual = sha((await readFile(join(root, file), 'utf8')).replaceAll('\r\n', '\n'))
    assert.equal(actual, versions.sources[file][loaded.flavor], `Runner dependency drift: ${file}`)
    runnerSourceHashes[file] = actual
  }
  runnerId = require.resolve(runnerPath)
  const { runProcess } = require(runnerId)
  const phases = {}
  for (const snapshot of ['current', 'main']) {
    for (const variant of ['before', 'fixed', 'without-rollback']) {
      const phase = `${snapshot}-${variant}`
      const report = join(scratch, `${phase}-tests.json`)
      const metrics = join(scratch, `${phase}-metrics.json`)
      const evaluated = join(scratch, `${phase}-evaluated.json`)
      const result = await runProcess({
        program: process.execPath,
        args: [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          join(artifact, 'phase.config.mjs'),
          '--reporter=json',
          `--outputFile=${report}`
        ],
        cwd: root,
        env: {
          ...process.env,
          ORCA_PARTITION_SNAPSHOT: snapshot,
          ORCA_PARTITION_VARIANT: variant,
          ORCA_PARTITION_METRICS: metrics,
          ORCA_PARTITION_EVALUATED: evaluated
        },
        timeoutMs: 120_000,
        maxOutputBytes: 4 * 1024 * 1024
      })
      assert.equal(result.timedOut, false, `${phase} timed out`)
      assert.equal(result.code, 0, `${phase} failed: ${result.stderr || result.stdout}`)
      const tests = JSON.parse(await readFile(report, 'utf8'))
      assert.equal(tests.numPassedTests, 13, `${phase} expected 13 cases`)
      assert.equal(tests.numFailedTests, 0)
      const actual = JSON.parse(await readFile(evaluated, 'utf8'))
      assert.deepEqual(
        actual.hashes,
        versions.evaluated[phase],
        `${phase} evaluated source graph differs`
      )
      phases[phase] = {
        passed: tests.numPassedTests,
        failed: tests.numFailedTests,
        cases: tests.testResults.flatMap((suite) =>
          suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status }))
        ),
        metrics: JSON.parse(await readFile(metrics, 'utf8')),
        evaluated: actual
      }
      console.log(
        `${phase}: ${tests.numPassedTests} passed; ${Object.keys(actual.hashes).length} evaluated sources`
      )
    }
  }
  const result = {
    passed: true,
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      platform: process.platform,
      arch: process.arch
    },
    workingFlavor: loaded.flavor,
    configurationAndFixtureHashes: loaded.runnerHashes,
    publicationCommit: versions.publicationCommit,
    dependencyScope: versions.scope,
    installedToolVersions: {
      vitest: require('vitest/package.json').version,
      esbuild: require('esbuild/package.json').version,
      diff: require('diff/package.json').version
    },
    reconstructedInputs,
    canonicalCrLfControl: true,
    runnerSourceHashes,
    artifactHashes,
    phases
  }
  await writeFile(
    process.argv[2] ? resolve(process.argv[2]) : join(artifact, 'node-results.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
} finally {
  if (runnerId) {
    delete require.cache[runnerId]
  }
  await rm(scratch, { recursive: true, force: true })
}
