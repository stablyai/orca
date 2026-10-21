const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '../../..')
const read = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const sourcePath = 'src/main/providers/working-directory-validation.ts'
const { applyPatch, parsePatch, reversePatch } = require('diff')
const { resolve } = path
const canonicalLf = (text) => text.replace(/\r\n/g, '\n')

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

async function load(fixed, fixtureKey) {
  const { before, after, hashes } = loadSources()
  const original = before.get(path.join(root, sourcePath))
  const candidate = after.get(path.join(root, sourcePath))
  const build = await esbuild.build({
    entryPoints: [path.join(root, sourcePath)],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    packages: 'external',
    write: false,
    metafile: true,
    plugins: [
      {
        name: 'validation-native-stat-port',
        setup(builder) {
          builder.onLoad({ filter: /working-directory-validation\.ts$/ }, (args) => {
            assert.equal(args.path, path.join(root, sourcePath))
            return { contents: fixed ? candidate : original, loader: 'ts' }
          })
          builder.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
            path: 'native-stat',
            namespace: 'fixture'
          }))
          builder.onResolve({ filter: /\/wsl$/ }, () => ({
            path: 'no-wsl-process',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'native-stat'
                ? `export const stat = (...args) => globalThis[${JSON.stringify(fixtureKey)}].stat(...args)`
                : "const unexpected = () => { throw new Error('No native WSL operation permitted') }; export const wslUncDirectoryExists = unexpected; export const wslUncDirectoryExistsAsync = unexpected",
            loader: 'js'
          }))
        }
      }
    ]
  })
  const filename = path.join(__dirname, 'in-memory-validation.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(build.outputFiles[0].text, filename)
  return {
    ...loaded.exports,
    versions: {
      sourceHashes: hashes,
      bundleSha256: sha(build.outputFiles[0].contents),
      dependencies: Object.keys(build.metafile.inputs)
        .filter((file) => file.startsWith('src/'))
        .map((file) => ({
          path: file,
          sha256: sha(
            file === sourcePath ? (fixed ? candidate : original) : read(path.join(root, file))
          )
        }))
    }
  }
}
module.exports = { load, loadSources, canonicalLf }
