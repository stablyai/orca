const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '../../..')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const read = (file) => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
const versionsText = read(path.join(__dirname, 'source-versions.json'))
const versions = JSON.parse(versionsText)

async function loadSource(fixed) {
  const evaluatedSources = {}
  const built = await build({
    stdin: {
      contents: [
        "export { TerminalKittyKeyboardModeTracker } from './src/shared/terminal-kitty-keyboard-mode-tracker'",
        "export { TerminalMouseModeMirror } from './src/main/daemon/terminal-mouse-mode-mirror'",
        "export { ownRetainedString, resetOwnRetainedStringCopier } from './src/shared/own-retained-string'"
      ].join('\n'),
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'hash-fenced-retained-mode-tails',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, ({ path: filename }) => {
            const relative = path.relative(root, filename).split(path.sep).join('/')
            const version = versions.sources[relative]
            assert.ok(version, `Unreviewed source: ${relative}`)
            let contents = read(filename)
            assert.equal(sha(contents), version.fixedSha256, `Fixed source changed: ${relative}`)
            if (!fixed && version.reverse) {
              for (const { from, to, count } of version.reverse) {
                assert.equal(contents.split(from).length - 1, count)
                contents = contents.replaceAll(from, to)
              }
            }
            const expected = fixed ? version.fixedSha256 : version.baselineSha256
            assert.equal(sha(contents), expected, `Evaluated source changed: ${relative}`)
            evaluatedSources[relative] = sha(contents)
            return { contents, loader: 'ts' }
          })
        }
      }
    ]
  })
  assert.deepEqual(Object.keys(evaluatedSources).sort(), Object.keys(versions.sources).sort())
  const filename = path.join(__dirname, fixed ? 'fixed-bundle.cjs' : 'baseline-bundle.cjs')
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(root)
  loaded._compile(built.outputFiles[0].text, filename)
  return {
    ...loaded.exports,
    evaluatedSources,
    bundleSha256: sha(built.outputFiles[0].text),
    sourceVersionsSha256: sha(versionsText)
  }
}

module.exports = { loadSource, sha, read }
