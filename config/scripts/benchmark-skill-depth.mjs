import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pass a pre-change skill-root-file-walk.ts snapshot as the only argument.
const baselinePath = process.argv[2]
const brokenLinks = process.argv.includes('--broken')
assert.ok(baselinePath, 'Pass a pre-change skill-root-file-walk.ts snapshot.')
const entry = 'src/main/skills/skill-root-file-walk.ts'
const baseline = readFileSync(baselinePath, 'utf8')
assert.notEqual(baseline, readFileSync(entry, 'utf8'), 'Do not compare the source to itself.')
let statCalls = 0

async function load(useBaseline) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: useBaseline
      ? [
          {
            name: 'baseline-skill-depth',
            setup(builder) {
              builder.onLoad({ filter: /skill-root-file-walk\.ts$/ }, () => ({
                contents: baseline,
                loader: 'ts'
              }))
            }
          }
        ]
      : []
  })
  const module = new Module(resolve('skill-depth-benchmark.cjs'))
  module.paths = Module._nodeModulePaths(process.cwd())
  const originalRequire = module.require.bind(module)
  module.require = (name) =>
    name === 'node:fs/promises'
      ? {
          ...fs,
          stat: (...args) => {
            statCalls++
            return fs.stat(...args)
          }
        }
      : originalRequire(name)
  module._compile(result.outputFiles[0].text, module.id)
  return module.exports.findSkillFiles
}

const before = await load(true)
const after = await load(false)
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'orca-skill-depth-benchmark-'))
try {
  for (const links of [0, 8, 100, 1000]) {
    const root = join(temporaryRoot, String(links))
    const edge = join(root, 'a', 'b', 'c', 'd')
    const target = join(temporaryRoot, 'target')
    await fs.mkdir(edge, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(join(target, 'SKILL.md'), 'skill')
    await fs.writeFile(join(edge, 'SKILL.md'), 'edge')
    for (let index = 0; index < links; index++) {
      await fs.symlink(
        brokenLinks ? join(target, 'missing') : target,
        join(edge, `link${index}`),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    }
    for (const depth of [4, 5]) {
      const timings = { before: [], after: [] }
      const counts = {}
      let rows
      for (let sample = 0; sample < 13; sample++) {
        const versions =
          sample % 2
            ? [
                ['after', after],
                ['before', before]
              ]
            : [
                ['before', before],
                ['after', after]
              ]
        for (const [name, walk] of versions) {
          statCalls = 0
          const start = performance.now()
          const result = await walk(root, depth)
          const elapsed = performance.now() - start
          if (rows) {
            assert.deepEqual(result, rows)
          }
          rows = result
          counts[name] = statCalls
          if (sample >= 2) {
            timings[name].push(elapsed)
          }
        }
      }
      console.log(
        JSON.stringify({
          links,
          brokenLinks,
          depth,
          statCalls: counts,
          rows: rows.length,
          medianMs: { before: median(timings.before), after: median(timings.after) }
        })
      )
    }
  }
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}
