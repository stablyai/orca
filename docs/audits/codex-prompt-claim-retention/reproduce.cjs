const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve, relative } = require('node:path')
const esbuild = require('esbuild')
const Module = require('node:module')

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')
const { root, before, after, hashes } = require('./sources.cjs')()
const sourcePath = 'src/main/codex/codex-prompt-registry.ts'
const source = before.get(resolve(root, sourcePath))
const candidate = after.get(resolve(root, sourcePath))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const entry = `
export { CodexPromptRegistry } from './src/main/codex/codex-prompt-registry';
export { cancelCodexStructuredTurn } from './src/main/codex/codex-structured-prompt-ownership';
export { CodexStructuredTurnCancellation } from './src/main/codex/codex-structured-turn-cancellation';
export { createCodexJournalTranslator } from './src/main/codex/codex-structured-journal-translation';
export { deliverCodexServerRequest, translateCodexNotification } from './src/main/codex/codex-structured-provider-events';
`

async function build(mode) {
  const result = await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: root,
      loader: 'ts',
      sourcefile: 'codex-claim-proof-entry.ts'
    },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'candidate-only-in-memory',
        setup(build) {
          build.onLoad({ filter: /\/codex-prompt-registry\.ts$/ }, (args) => {
            assert.equal(args.path, resolve(root, sourcePath))
            return { contents: mode === 'candidate' ? candidate : source, loader: 'ts' }
          })
        }
      }
    ]
  })
  const bundlePath = resolve(root, `codex-claim-${mode}-proof.cjs`)
  const loaded = new Module(bundlePath, module)
  loaded.filename = bundlePath
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(result.outputFiles[0].text, bundlePath)
  const dependencies = Object.keys(result.metafile.inputs)
    .filter((path) => path.startsWith('src/'))
    .map((path) => ({
      path,
      sha256: hash(
        path === sourcePath
          ? mode === 'original'
            ? source
            : candidate
          : readFileSync(resolve(root, path))
      )
    }))
  return { api: loaded.exports, bundleSha256: hash(result.outputFiles[0].contents), dependencies }
}

const run = require('./scenario.cjs')

async function main() {
  const deadline = setTimeout(() => {
    process.stderr.write('proof deadline\n')
    process.exit(2)
  }, 20_000)
  const results = {}
  const versions = {}
  for (const mode of ['original', 'candidate']) {
    const built = await build(mode)
    results[mode] = await run(built.api, mode)
    versions[mode] = { bundleSha256: built.bundleSha256, dependencies: built.dependencies }
  }
  clearTimeout(deadline)
  const report = {
    capturedAt: new Date().toISOString(),
    runtime: process.versions,
    scope:
      'Actual registry, server-request translation, cancellation ownership/cancellation class, journal translator, delayed turn completion. Injected accepted sink, interrupt transport, and compaction lookup. No provider, process enumeration/termination, or host data. Bundles load in memory; only the requested report is written.',
    sourceHashes: hashes,
    countsOnly: true,
    noPayloadAmplification: true,
    results,
    versions
  }
  const output = process.argv[2] ?? resolve(__dirname, 'node-results.json')
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      { output: relative(root, output), sourceHashes: report.sourceHashes, results },
      null,
      2
    )}\n`
  )
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exit(1)
})
