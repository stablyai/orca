import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'src/renderer/src/store/slices/tab-group-reference-repair.ts')
const directory = await mkdtemp(join(tmpdir(), 'orca-tab-repair-'))
const current = await readFile(source, 'utf8')
const indexed = `const orderedTabIds = new Set(group.tabOrder)
    const missingTabIds = ownedTabIds.filter((tabId) => !orderedTabIds.has(tabId))`
assert(current.includes(indexed), 'Expected indexed implementation')
try {
  const implementations = []
  for (const baseline of [true, false]) {
    const outfile = join(directory, baseline ? 'before.cjs' : 'after.cjs')
    await build({
      stdin: {
        contents: baseline
          ? current.replace(
              indexed,
              'const missingTabIds = ownedTabIds.filter((tabId) => !group.tabOrder.includes(tabId))'
            )
          : current,
        resolveDir: resolve(source, '..'),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      alias: { '@': join(root, 'src/renderer/src') }
    })
    implementations.push(createRequire(import.meta.url)(outfile).appendOwnedTabIdsToGroups)
  }
  const rows = []
  for (const count of [1, 10, 100, 1_000, 10_000]) {
    for (const missing of [false, true]) {
      const ids = Array.from({ length: count }, (_, i) => `tab-${i}`)
      const groups = [
        { id: 'group', worktreeId: 'workspace', activeTabId: null, tabOrder: ids, recentTabIds: [] }
      ]
      const owners = new Map(ids.map((id) => [missing ? `missing-${id}` : id, 'group']))
      assert.deepEqual(implementations[0](groups, owners), implementations[1](groups, owners))
      const iterations = Math.max(1, Math.floor(10_000 / count))
      const samples = [[], []]
      for (let sample = -3; sample < 11; sample++) {
        for (const index of sample % 2 === 0 ? [0, 1] : [1, 0]) {
          const start = performance.now()
          for (let i = 0; i < iterations; i++) {
            implementations[index](groups, owners)
          }
          const elapsed = (performance.now() - start) / iterations
          if (sample >= 0) {
            samples[index].push(elapsed)
          }
        }
      }
      rows.push({
        count,
        missing,
        iterations,
        beforeMs: samples[0].sort((a, b) => a - b)[5],
        afterMs: samples[1].sort((a, b) => a - b)[5]
      })
    }
  }
  console.log(
    JSON.stringify(
      { node: process.version, platform: process.platform, samples: 11, warmups: 3, rows },
      null,
      2
    )
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
