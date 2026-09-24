const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')
const { build } = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const canonicalLf = (value) => value.replaceAll('\r\n', '\n')
const read = (file) => canonicalLf(fs.readFileSync(file, 'utf8'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const versions = JSON.parse(read(path.join(__dirname, 'source-versions.json')))
const relative = (file) => path.relative(root, file).split(path.sep).join('/')

function loadSources(readSource = read) {
  const fixed = canonicalLf(readSource(path.join(root, versions.sourcePath)))
  assert.equal(sha(fixed), versions.fixedSha256)
  const patches = parsePatch(canonicalLf(readSource(path.join(__dirname, 'fix.patch'))))
  assert.equal(patches.length, 1)
  assert.equal(patches[0].newFileName, `b/${versions.sourcePath}`)
  const before = applyPatch(fixed, reversePatch(patches[0]))
  assert.notEqual(before, false)
  assert.equal(sha(before), versions.baselineSha256)
  return { before, fixed }
}

async function load(phase, readSource = read) {
  assert.ok(['before', 'fixed'].includes(phase))
  const checked = loadSources(readSource)
  const evaluatedSources = {}
  const provenanceSources = {}
  const built = await build({
    stdin: {
      contents: [
        "export { DaemonPtyAdapter } from './src/main/daemon/daemon-pty-adapter'",
        "export { DegradedDaemonPtyProvider } from './src/main/daemon/degraded-daemon-pty-provider'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    plugins: [
      {
        name: 'hash-fenced-owner-incarnation-sources',
        setup(builder) {
          builder.onResolve({ filter: /^\./ }, (args) => {
            const base = path.resolve(args.resolveDir, args.path)
            for (const file of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
              const key = relative(file)
              if (key === versions.sourcePath || Object.hasOwn(versions.dependencies, key)) {
                return { path: file }
              }
            }
            return undefined
          })
          builder.onLoad({ filter: /\.ts$/ }, ({ path: file }) => {
            const key = relative(file)
            let contents = canonicalLf(readSource(file))
            const actual = sha(contents)
            provenanceSources[key] = actual
            if (key === versions.sourcePath) {
              assert.equal(actual, versions.fixedSha256)
              contents = checked[phase]
            } else {
              assert.ok(versions.dependencies[key]?.includes(actual), `Dependency drift: ${key}`)
            }
            evaluatedSources[key] = sha(contents)
            return { contents, loader: 'ts' }
          })
        }
      }
    ]
  })
  const evaluatedKeys = Object.keys(evaluatedSources).sort()
  const recognizedGraph = [versions.workingEvaluated, versions.publicationEvaluated].some(
    (known) => JSON.stringify(Object.keys(known).sort()) === JSON.stringify(evaluatedKeys)
  )
  assert.equal(recognizedGraph, true, 'Unreviewed evaluated module graph')
  const filename = path.join(__dirname, `${phase}-bundle.cjs`)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(built.outputFiles[0].text, filename)
  return {
    api: loaded.exports,
    provenance: {
      evaluatedSources,
      provenanceSources,
      bundleSha256: sha(built.outputFiles[0].text)
    }
  }
}

module.exports = { load, loadSources, read, sha, root, versions }
