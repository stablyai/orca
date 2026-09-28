import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: ['src/shared/quick-open-filter.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent'
})
const { shouldExcludeQuickOpenRelPath: after } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)
// Original production predicate, including its exact boundary check.
function before(relPath, prefixes) {
  for (const prefix of prefixes) {
    if (relPath === prefix) {
      return true
    }
    if (relPath.length > prefix.length && relPath.startsWith(`${prefix}/`)) {
      return true
    }
  }
  return false
}
const files = Array.from(
  { length: 100000 },
  (_, index) => `src/components/group-${index % 100}/file-${index}.tsx`
)
function run(fn, prefixes) {
  let excluded = 0
  for (const file of files) {
    excluded += Number(fn(file, prefixes))
  }
  return excluded
}
function measure(fn, prefixes) {
  run(fn, prefixes)
  const samples = []
  for (let index = 0; index < 5; index++) {
    const start = performance.now()
    run(fn, prefixes)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[2]
}
const results = []
for (const count of [0, 10, 100, 500]) {
  const prefixes = Array.from({ length: count }, (_, index) => `nested-worktrees/worktree-${index}`)
  assert.equal(run(after, prefixes), run(before, prefixes))
  results.push({
    files: files.length,
    exclusions: count,
    beforeMs: measure(before, prefixes),
    afterMs: measure(after, prefixes)
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
