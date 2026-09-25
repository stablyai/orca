const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const canonical = (value) => value.replaceAll('\r\n', '\n')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const readText = (file) => canonical(readFileSync(file, 'utf8'))
const versions = JSON.parse(readText(path.join(__dirname, 'source-versions.json')))

function loadSources(read = readText) {
  const fixed = canonical(read(path.join(root, versions.sourcePath)))
  assert.equal(sha(fixed), versions.fixedSha256, 'Fixed source drift')
  const reverse = (name) => {
    const patches = parsePatch(canonical(read(path.join(__dirname, name))))
    assert.equal(patches.length, 1)
    assert.equal(patches[0].newFileName, `b/${versions.sourcePath}`)
    const source = applyPatch(fixed, reversePatch(patches[0]))
    assert.notEqual(source, false)
    return source
  }
  const baseline = reverse('fix.patch')
  const reported = reverse('reported.patch')
  const marker = '    current.push(delta)'
  assert.equal(reported.split(marker).length, 2)
  const reportedFixed = reported.replace(
    marker,
    '    if (delta.length > 0) {\n      current.push(delta)\n    }'
  )
  assert.equal(sha(baseline), versions.baselineSha256, 'Baseline source drift')
  assert.equal(sha(reported), versions.reportedSha256, 'Reported source drift')
  assert.equal(sha(reportedFixed), versions.reportedFixedSha256)
  return { baseline, fixed, reported, reportedFixed }
}

async function load(phase) {
  const sources = loadSources()
  assert.ok(Object.hasOwn(sources, phase))
  for (const [file, expected] of Object.entries(versions.commonDependencies)) {
    assert.equal(sha(readText(path.join(root, file))), expected, `Dependency drift: ${file}`)
  }
  for (const caller of versions.callerSourceHashes) {
    assert.equal(
      sha(readText(path.join(root, caller.path))),
      caller.working,
      `Caller drift: ${caller.path}`
    )
  }
  const marker = '  const flushKey = (key: string): boolean => {'
  const source = sources[phase]
  assert.equal(source.split(marker).length, 2)
  // Measurement only reads cardinalities; it never changes stream ownership or contents.
  const measured = source.replace(
    marker,
    `  globalThis.__orcaEmptyDeltaReaders.push(() => ({
    streams: streams.size,
    slots: [...streams.values()].reduce((count, stream) => count + stream.chunks.length, 0),
    retainedBytes: totalRetainedBytes,
    observedBytes: [...streams.values()].reduce((count, stream) => count + stream.observedBytes, 0)
  }))\n${marker}`
  )
  const build = await esbuild.build({
    stdin: {
      contents:
        "export { createCodexStructuredItemStreams } from './src/main/codex/codex-structured-item-streams'; export { createAgentSessionDeltaCoalescer } from './src/main/native-chat/agent-session-wire/agent-session-delta-coalescer'",
      resolveDir: root,
      loader: 'ts'
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    metafile: true,
    plugins: [
      {
        name: 'read-private-array-cardinality',
        setup(builder) {
          builder.onLoad({ filter: /agent-session-delta-coalescer\.ts$/ }, (args) => {
            assert.equal(args.path, path.join(root, versions.sourcePath))
            return { contents: measured, loader: 'ts' }
          })
        }
      }
    ]
  })
  const actualInputs = Object.keys(build.metafile.inputs)
    .filter((file) => file.startsWith('src/'))
    .sort()
  assert.deepEqual(
    actualInputs,
    [...Object.keys(versions.commonDependencies), versions.sourcePath].sort()
  )
  const filename = path.join(__dirname, `in-memory-${phase}.cjs`)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(build.outputFiles[0].text, filename)
  return {
    ...loaded.exports,
    sourceSha256: sha(source),
    bundleSha256: sha(build.outputFiles[0].contents)
  }
}

module.exports = { load, loadSources, root, sha, versions }
