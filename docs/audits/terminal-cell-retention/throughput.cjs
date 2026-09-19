const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const { build } = require('esbuild')
const { applyPatch } = require('diff')
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
const { createHash } = require('node:crypto')
const repositoryRoot = path.resolve(__dirname, '../../..')
const baselineBundle = process.env.ORCA_AUDIT_HEADLESS_BASELINE
  ? path.resolve(process.env.ORCA_AUDIT_HEADLESS_BASELINE)
  : require.resolve('@xterm/headless')
const baselineBytes = fs.readFileSync(baselineBundle)
const map = JSON.parse(fs.readFileSync(`${baselineBundle}.map`, 'utf8'))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sources = new Map(
  map.sources.map((source, index) => [source.replace(/^.*?\/src\//, ''), map.sourcesContent[index]])
)
const linePath = 'common/buffer/BufferLine.ts'
const desktopPackageRoot = path.resolve(path.dirname(require.resolve('@xterm/xterm')), '..')
const sourceRoot = path.join(desktopPackageRoot, 'src')
assert.equal(
  JSON.parse(fs.readFileSync(path.join(desktopPackageRoot, 'package.json'), 'utf8')).commit,
  JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'config/patches/xterm-upstream.json'), 'utf8')
  ).upstream.commit,
  'Fallback enum-only sources must match the pinned upstream commit'
)
const patched = applyPatch(
  sources.get(linePath),
  fs.readFileSync(
    path.join(repositoryRoot, 'config/patches/xterm-src/@xterm__headless@6.1.0-beta.302.src.patch'),
    'utf8'
  )
)
assert.equal(
  typeof patched,
  'string',
  'Baseline source is already patched or differs; set ORCA_AUDIT_HEADLESS_BASELINE to the pristine pinned headless bundle'
)

async function bundle(variant) {
  const result = await build({
    stdin: {
      contents: `export { Terminal } from 'headless/public/Terminal'; export { BufferLine, DEFAULT_ATTR_DATA } from 'common/buffer/BufferLine';`,
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'captured-sourcemap',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => ({
            path: `${(args.path.startsWith('.')
              ? path.posix.join(path.posix.dirname(args.importer), args.path)
              : args.path
            ).replace(/\.ts$/, '')}.ts`,
            namespace: 'mapped'
          }))
          build.onLoad({ filter: /.*/, namespace: 'mapped' }, (args) => {
            let contents = sources.get(args.path)
            if (contents === undefined) {
              contents = fs.readFileSync(path.join(sourceRoot, args.path), 'utf8')
            }
            if (args.path === linePath && variant !== 'baseline') {
              contents = patched
            }
            assert.equal(typeof contents, 'string', args.path)
            return { contents, loader: 'ts' }
          })
        }
      }
    ]
  })
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'orca-cell-throughput-proof-'))
  let moduleId
  try {
    const bundlePath = path.join(scratch, 'terminal.cjs')
    fs.writeFileSync(bundlePath, result.outputFiles[0].text)
    moduleId = require.resolve(bundlePath)
    return require(moduleId)
  } finally {
    if (moduleId) {
      delete require.cache[moduleId]
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
async function main() {
  const variants = ['baseline', 'patched']
  const cases = await Promise.all(variants.map(bundle))
  const lines = cases.map((c) => new c.BufferLine(120))
  const terminals = cases.map(
    (c) =>
      new c.Terminal({
        cols: 120,
        rows: 40,
        scrollback: 0,
        allowProposedApi: true,
        logLevel: 'off'
      })
  )
  const text = `${'a'.repeat(118)}\r\n`.repeat(10000)
  const timings = Object.fromEntries(variants.map((v) => [v, { setterMs: [], terminalMs: [] }]))
  for (let round = 0; round < 7; round++) {
    for (let i = 0; i < cases.length; i++) {
      const line = lines[i],
        attrs = cases[i].DEFAULT_ATTR_DATA
      let start = performance.now()
      for (let j = 0; j < 3000000; j++) {
        line.setCellFromCodepoint(j % 120, 65 + (j % 26), 1, attrs)
      }
      timings[variants[i]].setterMs.push(Math.round((performance.now() - start) * 10) / 10)
      start = performance.now()
      terminals[i]._core.writeSync(text)
      timings[variants[i]].terminalMs.push(Math.round((performance.now() - start) * 10) / 10)
    }
  }
  terminals.forEach((t) => t.dispose())
  console.log(
    JSON.stringify(
      {
        node: process.version,
        baselineBundleSha256: hash(baselineBytes),
        baselineBufferLineSha256: hash(sources.get(linePath)),
        patchedBufferLineSha256: hash(patched),
        bytesPerTerminalRound: text.length,
        timings,
        limits:
          'Real headless source bundled in memory with esbuild from installed baseline sourcemap; omitted enum-only source files come from installed desktop source at the same pinned upstream commit. Not the published webpack bundle. No renderer windows.'
      },
      null,
      2
    )
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
