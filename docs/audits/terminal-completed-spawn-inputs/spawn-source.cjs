const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const versions = require('./source-versions.json')

const root = path.resolve(__dirname, '../../..')
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const patches = parsePatch(readText(path.join(__dirname, 'fix.patch')))
assert.equal(patches.length, versions.sources.length)
const fixedSources = new Map()
const baselineSources = new Map()
const evaluatedSourceHashes = {}
const sourceMapPath = process.env.ORCA_SPAWN_INPUT_PROOF_SOURCE_MAP
const sourceOverrides = sourceMapPath ? JSON.parse(readText(path.resolve(sourceMapPath))) : null
if (sourceMapPath) {
  assert.equal(typeof sourceOverrides, 'object')
  assert.notEqual(sourceOverrides, null)
  assert.equal(Array.isArray(sourceOverrides), false)
  assert.deepEqual(
    Object.keys(sourceOverrides).sort(),
    versions.sources.map((source) => source.sourcePath).sort()
  )
}
for (const source of versions.sources) {
  const file = path.join(root, source.sourcePath)
  const fixed = sourceOverrides ? sourceOverrides[source.sourcePath] : readText(file)
  assert.equal(typeof fixed, 'string')
  const pair = [source, ...(source.alternatePairs ?? [])].find(
    (entry) => entry.fixedSha256 === sha(fixed)
  )
  assert.ok(pair, `Unreviewed product source: ${source.sourcePath}`)
  const patch = patches.find((entry) => entry.oldFileName === `a/${source.sourcePath}`)
  assert.ok(patch)
  const baseline = applyPatch(fixed, reversePatch(patch))
  assert.notEqual(baseline, false)
  assert.equal(sha(baseline), pair.baselineSha256, `Baseline changed: ${source.sourcePath}`)
  fixedSources.set(file, fixed)
  baselineSources.set(file, baseline)
  evaluatedSourceHashes[source.sourcePath] = { baseline: sha(baseline), fixed: sha(fixed) }
}

const sourceMode = sourceMapPath
  ? 'mapped modules with working-tree dependencies'
  : 'working-tree modules and dependencies'
const reportPrefix = sourceMapPath ? 'mapped-' : ''

async function loadExports(fixed) {
  const sources = fixed ? fixedSources : baselineSources
  const build = await esbuild.build({
    stdin: {
      contents: [
        "export { TerminalHost } from './src/main/daemon/terminal-host'",
        "export { DaemonTerminalAdmission } from './src/main/daemon/daemon-terminal-admission'",
        "export { DaemonPtySpawnPreparations } from './src/main/daemon/daemon-pty-spawn-preparations'"
      ].join(';'),
      resolveDir: root,
      loader: 'ts'
    },
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    write: false,
    plugins: [
      {
        name: 'reviewed-spawn-input-sources',
        setup(builder) {
          builder.onLoad(
            { filter: /(?:terminal-host(?:-session-create)?|session-output-pipeline)\.ts$/ },
            (args) => {
              const contents = sources.get(args.path)
              return contents === undefined ? undefined : { contents, loader: 'ts' }
            }
          )
          builder.onResolve({ filter: /pty-descendant-termination$/ }, () => ({
            path: 'no-os-signals',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              "export function killWithDescendantSweep() { throw new Error('Unexpected real process teardown') }",
            loader: 'js'
          }))
        }
      }
    ]
  })
  const filename = path.join(__dirname, 'bundled-terminal-host.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(build.outputFiles[0].text, filename)
  return loaded.exports
}

async function load(fixed) {
  return (await loadExports(fixed)).TerminalHost
}

module.exports = {
  load,
  loadExports,
  versions,
  sha,
  baselineSources,
  evaluatedSourceHashes,
  sourceMode,
  reportPrefix
}
