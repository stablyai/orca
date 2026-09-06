import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'

const baseline = process.argv[2]
if (!baseline) {
  throw new Error('Usage: node config/scripts/mobile-file-ranking-benchmark.mjs <baseline-ref>')
}
async function load(source) {
  const js = stripTypeScriptTypes(source, { mode: 'transform' })
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
function measure(fn, paths, query) {
  for (let warmup = 0; warmup < 10; warmup++) {
    fn(paths, query, 16)
  }
  const samples = []
  for (let i = 0; i < 9; i++) {
    const start = performance.now()
    fn(paths, query, 16)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[4]
}
const results = []
for (const [file, name] of [
  ['src/main/runtime/runtime-mobile-file-path-search.ts', 'rankRuntimeMobileFilePaths'],
  ['mobile/src/session/mobile-native-chat-autocomplete.ts', 'rankSuggestions']
]) {
  const before = (
    await load(execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }))
  )[name]
  const after = (await load(readFileSync(file, 'utf8')))[name]
  for (const count of [100, 100000]) {
    const paths = Array.from(
      { length: count },
      (_, i) => `src/components/workspace/group-${i % 100}/file-${i}.tsx`
    )
    for (const query of ['file-9', 'missing', 'workspace']) {
      assert.deepEqual(after(paths, query, 16), before(paths, query, 16))
      results.push({
        function: name,
        paths: count,
        query,
        beforeMs: measure(before, paths, query),
        afterMs: measure(after, paths, query)
      })
    }
  }
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
