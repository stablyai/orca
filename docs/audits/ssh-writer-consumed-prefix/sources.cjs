const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { applyPatch, parsePatch, reversePatch } = require('diff')
const { resolve } = path
const root = resolve(__dirname, '../../..')
const canonicalLf = (text) => text.replace(/\r\n/g, '\n')
const read = (file) => canonicalLf(readFileSync(file, 'utf8'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sourcePath = 'src/main/ssh/ssh-multiplexer-writer-lane-scheduler.ts'

function loadSources({ readText = (file) => readFileSync(file, 'utf8') } = {}) {
  const root = resolve(__dirname, '../../..')
  const expected = JSON.parse(readFileSync(resolve(__dirname, 'source-versions.json'), 'utf8'))
  const parsed = parsePatch(canonicalLf(readText(resolve(__dirname, 'fix.patch'))))
  const before = new Map()
  const after = new Map()
  const hashes = {}
  assert.equal(parsed.length, 1)
  for (const patch of parsed) {
    const path = patch.newFileName.replace(/^b\//, '')
    assert.ok(Object.hasOwn(expected.baselineHashes, path), `Unexpected patch path: ${path}`)
    const absolute = resolve(root, path)
    const current = canonicalLf(readText(absolute))
    const baseline = applyPatch(current, reversePatch(patch))
    assert.notEqual(baseline, false, `Source changed; review fix.patch: ${path}`)
    const hash = (source) => createHash('sha256').update(source).digest('hex')
    assert.equal(hash(baseline), expected.baselineHashes[path], `Baseline drift: ${path}`)
    assert.equal(hash(current), expected.fixedHashes[path], `Fixed source drift: ${path}`)
    before.set(absolute, baseline)
    after.set(absolute, current)
    hashes[path] = { before: hash(baseline), after: hash(current) }
  }
  return { root, before, after, hashes }
}

async function load(fixed) {
  const { before, after, hashes } = loadSources()
  const source = (fixed ? after : before).get(resolve(root, sourcePath))
  const built = await esbuild.build({
    stdin: {
      contents:
        "export { SshChannelMultiplexer } from './src/main/ssh/ssh-channel-multiplexer'; export { writeToSshPtyWithSettlement } from './src/main/providers/ssh-pty-write'",
      resolveDir: root,
      sourcefile: 'fixture.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    plugins: [
      {
        name: 'scheduler-variant',
        setup(builder) {
          builder.onLoad({ filter: /ssh-multiplexer-writer-lane-scheduler\.ts$/ }, (args) => {
            assert.equal(args.path, resolve(root, sourcePath))
            return { contents: source, loader: 'ts' }
          })
        }
      }
    ]
  })
  const filename = resolve(__dirname, 'in-memory.cjs')
  const expected = JSON.parse(readFileSync(resolve(__dirname, 'source-versions.json'), 'utf8'))
  const dependencies = Object.keys(built.metafile.inputs)
    .filter((file) => file.startsWith('src/'))
    .map((file) => ({
      path: file,
      sha256: sha(file === sourcePath ? source : read(resolve(root, file)))
    }))
  const baselineDependencies = new Map(
    expected.provenance
      .filter((entry) => entry.bundled)
      .map((entry) => [entry.path, entry.currentBaselineSha256])
  )
  assert.equal(dependencies.length, baselineDependencies.size)
  for (const dependency of dependencies) {
    const expectedHash =
      fixed && dependency.path === sourcePath
        ? expected.fixedHashes[sourcePath]
        : baselineDependencies.get(dependency.path)
    assert.equal(dependency.sha256, expectedHash, `Dependency drift: ${dependency.path}`)
  }
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(built.outputFiles[0].text, filename)
  return {
    ...loaded.exports,
    versions: {
      sourceHashes: hashes,
      bundleSha256: sha(built.outputFiles[0].contents),
      dependencies
    }
  }
}
module.exports = { load, loadSources, canonicalLf }
