import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Pass the pre-change file-explorer-entries.ts snapshot as the only argument.
const baselinePath = process.argv[2]
assert.ok(baselinePath, 'Pass a pre-change file-explorer-entries.ts snapshot.')
const entry = 'src/renderer/src/components/right-sidebar/file-explorer-entries.ts'
const baseline = readFileSync(baselinePath, 'utf8')
assert.notEqual(baseline, readFileSync(entry, 'utf8'), 'Do not compare the source to itself.')

async function load(useBaseline) {
  const result = await build({
    stdin: {
      contents: `export { isDotfileRelativePath } from './${entry}';
export { createNameFilteredFileExplorerProjection } from './src/renderer/src/components/right-sidebar/file-explorer-name-filter-projection.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    alias: { '@': resolve('src/renderer/src') },
    plugins: useBaseline
      ? [
          {
            name: 'baseline-dotfile-predicate',
            setup(builder) {
              builder.onLoad({ filter: /file-explorer-entries\.ts$/ }, () => ({
                contents: baseline,
                loader: 'ts'
              }))
            }
          }
        ]
      : []
  })
  const module = new Module(resolve('dotfile-benchmark.cjs'))
  module.paths = Module._nodeModulePaths(process.cwd())
  module._compile(result.outputFiles[0].text, module.id)
  return module.exports
}

const versions = [await load(true), await load(false)]
let parityCases = 0
function check(path, depth) {
  assert.equal(
    versions[0].isDotfileRelativePath(path),
    versions[1].isDotfileRelativePath(path),
    path
  )
  parityCases++
  if (depth > 0) {
    for (const character of ['.', '/', '\\', 'a', '\n']) {
      check(path + character, depth - 1)
    }
  }
}
check('', 8)

function measure(functions, iterations = 1) {
  let sink = 0
  const run = (fn) => {
    for (let i = 0; i < iterations; i++) {
      sink += Number(fn())
    }
  }
  for (const fn of functions) {
    for (let warmup = 0; warmup < 3; warmup++) {
      run(fn)
    }
  }
  const samples = [[], []]
  for (let round = 0; round < 11; round++) {
    for (const variant of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now()
      run(functions[variant])
      samples[variant].push(performance.now() - start)
    }
  }
  return {
    beforeMs: samples[0].sort((a, b) => a - b)[5],
    afterMs: samples[1].sort((a, b) => a - b)[5],
    iterations,
    sink
  }
}

const predicates = []
for (const path of [
  'a',
  '.env',
  'packages/pkg/src/file.tsx',
  `a${'.'.repeat(254)}`,
  `${'/'.repeat(4096)}.`,
  `${'../'.repeat(1000)}file.ts`,
  '😀/.你好',
  '\n/.\n'
]) {
  check(path, 0)
  predicates.push({
    pathLength: path.length,
    prefix: path.slice(0, 40),
    ...measure(
      versions.map((version) => () => version.isDotfileRelativePath(path)),
      10_000
    )
  })
}

const projections = []
for (const count of [1000, 10_000, 100_000]) {
  for (const query of ['nonmatching-needle', 'file-42']) {
    const args = {
      ignoredSet: new Set(['unrelated']),
      nameFilter: {
        query,
        relativePaths: Array.from(
          { length: count },
          (_, i) => `packages/package-${i % 50}/src/components/section-${i % 10}/file-${i}.tsx`
        )
      },
      showDotfiles: false,
      showGitIgnoredFiles: false,
      worktreePath: '/workspace'
    }
    const functions = versions.map(
      (version) => () => version.createNameFilteredFileExplorerProjection(args)
    )
    const rows = functions.map((fn) => {
      const projection = fn()
      return Array.from({ length: projection.getVisibleCount() }, (_, i) =>
        projection.getRowAtIndex(i)
      )
    })
    assert.deepEqual(rows[0], rows[1])
    projections.push({
      count,
      query,
      visibleRows: rows[0].length,
      ...measure(functions.map((fn) => () => fn().getVisibleCount()))
    })
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      baselinePath: resolve(baselinePath),
      parityCases,
      samples: 11,
      warmups: 3,
      predicates,
      projections
    },
    null,
    2
  )
)
