const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')
const { build } = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')

const root = path.resolve(__dirname, '../../..')
const sourcePath = 'src/main/plugins/plugin-worker-output-buffer.ts'
const canonicalLf = (value) => value.replaceAll('\r\n', '\n')
const read = (file) => canonicalLf(fs.readFileSync(file, 'utf8'))
const sha = (value) => createHash('sha256').update(value).digest('hex')

function loadSources(readText = read) {
  const versionsText = read(path.join(__dirname, 'source-versions.json'))
  const versions = JSON.parse(versionsText)
  const patches = parsePatch(canonicalLf(readText(path.join(__dirname, 'fix.patch'))))
  assert.equal(patches.length, 1)
  assert.equal(patches[0].newFileName, `b/${sourcePath}`)
  const current = canonicalLf(readText(path.join(root, sourcePath)))
  const before = applyPatch(current, reversePatch(patches[0]))
  assert.notEqual(before, false, 'The parser no longer matches the reviewed patch')
  assert.equal(sha(before), versions.baselineSha256)
  assert.equal(sha(current), versions.fixedSha256)
  const checkedSources = { [sourcePath]: sha(current) }
  for (const [relative, expected] of Object.entries(versions.dependencies)) {
    const actual = sha(canonicalLf(readText(path.join(root, relative))))
    assert.equal(actual, expected, `Reviewed dependency changed: ${relative}`)
    checkedSources[relative] = actual
  }
  return { before, current, checkedSources, versions, versionsSha256: sha(versionsText) }
}

async function load(variant) {
  const checked = loadSources()
  let source = variant === 'before' ? checked.before : checked.current
  if (variant === 'tail-only') {
    source = `import { ownRetainedString } from '../../shared/own-retained-string'\n${checked.before}`
    assert.equal(source.split('        buffered += segment').length, 2)
    source = source.replace(
      '        buffered += segment',
      '        buffered += newline === -1 ? ownRetainedString(segment) : segment'
    )
    assert.equal(sha(source), checked.versions.tailOnlySha256)
  }
  const entries = [
    "export { pipePluginWorkerOutput } from './src/main/plugins/plugin-worker-output-buffer'",
    "export { PluginLogBuffer } from './src/main/plugins/plugin-log-buffer'"
  ]
  if (variant !== 'before') {
    entries.push(
      "export { ownRetainedString, resetOwnRetainedStringCopier } from './src/shared/own-retained-string'"
    )
  }
  const evaluatedSources = {}
  const built = await build({
    stdin: { contents: entries.join('\n'), resolveDir: root },
    platform: 'node',
    format: 'cjs',
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'hash-fenced-plugin-output',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, ({ path: file }) => {
            const relative = path.relative(root, file).split(path.sep).join('/')
            assert.ok(Object.hasOwn(checked.checkedSources, relative), relative)
            const contents = relative === sourcePath ? source : read(file)
            evaluatedSources[relative] = sha(contents)
            return { contents, loader: 'ts' }
          })
        }
      }
    ]
  })
  const filename = path.join(__dirname, `${variant}-bundle.cjs`)
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(built.outputFiles[0].text, filename)
  return {
    ...loaded.exports,
    provenance: {
      checkedSources: checked.checkedSources,
      evaluatedSources,
      sourceVersionsSha256: checked.versionsSha256,
      bundleSha256: sha(built.outputFiles[0].text)
    }
  }
}

module.exports = { load, loadSources, sha, read }
