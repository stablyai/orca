const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { resolve } = path
const Module = require('node:module')
const esbuild = require('esbuild')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const { applyPatch, parsePatch, reversePatch } = require('diff')

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

async function load(fixed) {
  const { root, before, after, hashes } = loadSources()
  const sourcePath = 'src/main/daemon/pty-subprocess/subprocess-handle.ts'
  const selected = (fixed ? after : before).get(path.join(root, sourcePath))
  const build = await esbuild.build({
    entryPoints: [path.join(root, sourcePath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    metafile: true,
    plugins: [
      {
        name: 'capture-only-projection',
        setup(build) {
          build.onLoad({ filter: /subprocess-handle\.ts$/ }, (args) => {
            assert.equal(args.path, path.join(root, sourcePath))
            return { contents: selected, loader: 'ts' }
          })
          build.onResolve(
            { filter: /(?:posix-pty-process-groups|posix-pty-foreground-group|windows-pty-job)$/ },
            (args) => ({ path: args.path, namespace: 'guard' })
          )
          build.onLoad({ filter: /.*/, namespace: 'guard' }, () => ({
            contents: `
        const unexpected = () => { throw new Error('No native termination permitted in proof') }
        export const forceKillPosixPtyProcessGroups = unexpected
        export const signalPosixPtyForegroundGroup = unexpected
        export const terminatePtyJob = unexpected
        export const isPtyJobOwnershipAvailable = unexpected
        export const listPtyJobProcessIds = unexpected
      `,
            loader: 'js'
          }))
        }
      }
    ]
  })
  const file = path.join(root, 'native-pty-env-proof.cjs')
  const module_ = new Module(file, module)
  module_.filename = file
  module_.paths = Module._nodeModulePaths(root)
  module_._compile(build.outputFiles[0].text, file)
  return {
    create: module_.exports.createDaemonPtySubprocessHandle,
    hashes,
    bundleSha256: sha(build.outputFiles[0].contents),
    dependencies: Object.keys(build.metafile.inputs)
      .filter((file) => file.startsWith('src/'))
      .map((file) => ({
        path: file,
        sha256: sha(
          file === sourcePath ? selected : canonicalLf(readFileSync(path.join(root, file), 'utf8'))
        )
      }))
  }
}

module.exports = { canonicalLf, load, loadSources }
