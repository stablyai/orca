const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { build } = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const canonical = (value) => value.replaceAll('\r\n', '\n')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const readText = (file) => canonical(readFileSync(file, 'utf8'))
const versions = JSON.parse(readText(path.join(__dirname, 'source-versions.json')))

function loadSources(read = readText) {
  const fixed = canonical(read(path.join(root, versions.sourcePath)))
  assert.equal(sha(fixed), versions.fixedSha256, 'Fixed scanner drift')
  const patches = parsePatch(canonical(read(path.join(__dirname, 'fix.patch'))))
  assert.equal(patches.length, 1)
  assert.equal(patches[0].newFileName, `b/${versions.sourcePath}`)
  const baseline = applyPatch(fixed, reversePatch(patches[0]))
  assert.notEqual(baseline, false)
  assert.equal(sha(baseline), versions.baselineSha256, 'Baseline scanner drift')
  return { baseline, fixed }
}

async function load(fixed) {
  const sources = loadSources()
  const callerSourceHashes = {}
  for (const caller of versions.callerHashes) {
    const actual = sha(readText(path.join(root, caller.path)))
    assert.ok(caller.acceptedSha256.includes(actual), `Caller drift: ${caller.path}`)
    callerSourceHashes[caller.path] = actual
  }
  const evaluatedSources = {}
  const built = await build({
    stdin: {
      contents: [
        "export { createOsc133CommandFinishedScanner } from './src/shared/terminal-osc133-command-finished'",
        "export { BackgroundTransientFactRelay } from './src/main/daemon/daemon-background-transient-facts'",
        "export { createTerminalTitleTracker } from './src/shared/terminal-output-side-effects'",
        "export { ownRetainedString, resetOwnRetainedStringCopier } from './src/shared/own-retained-string'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'hash-fenced-osc133-carry',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, ({ path: filename }) => {
            const relative = path.relative(root, filename).split(path.sep).join('/')
            const expected = versions.dependencies[relative]
            assert.ok(expected, `Unreviewed dependency: ${relative}`)
            let contents = readText(filename)
            assert.equal(sha(contents), expected, `Dependency drift: ${relative}`)
            if (relative === versions.sourcePath) {
              contents = fixed ? sources.fixed : sources.baseline
            }
            evaluatedSources[relative] = sha(contents)
            return { contents, loader: 'ts' }
          })
        }
      }
    ]
  })
  assert.deepEqual(Object.keys(evaluatedSources).sort(), Object.keys(versions.dependencies).sort())
  const filename = path.join(__dirname, fixed ? 'fixed-bundle.cjs' : 'baseline-bundle.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(built.outputFiles[0].text, filename)
  return {
    api: loaded.exports,
    sourceSha256: sha(fixed ? sources.fixed : sources.baseline),
    bundleSha256: sha(built.outputFiles[0].text),
    evaluatedSources,
    callerSourceHashes
  }
}

module.exports = { load, loadSources, readText, root, sha, versions }
