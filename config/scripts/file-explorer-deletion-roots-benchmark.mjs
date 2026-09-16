import assert from 'node:assert/strict'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../..', import.meta.url))
const bundled = await build({
  stdin: {
    contents: `export { selectDeletionRoots } from './file-explorer-batch-deletion';
      export { isPathEqualOrDescendant } from './file-explorer-paths';`,
    resolveDir: join(root, 'src/renderer/src/components/right-sidebar'),
    loader: 'ts'
  },
  alias: { '@': join(root, 'src/renderer/src') },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent'
})
const { selectDeletionRoots, isPathEqualOrDescendant } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

// Original production selector; both paths use the same path-comparison implementation.
function original(nodes) {
  return nodes.filter(
    (n) =>
      !nodes.some(
        (other) => other !== n && other.isDirectory && isPathEqualOrDescendant(n.path, other.path)
      )
  )
}

function measure(run, nodes) {
  for (let index = 0; index < 3; index++) {
    run(nodes)
  }
  const samples = []
  for (let index = 0; index < 11; index++) {
    const start = performance.now()
    run(nodes)
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[5]
}

const results = []
for (const [fileCount, directoryCount] of [
  [100, 0],
  [1000, 0],
  [5000, 0],
  [5000, 5],
  [0, 100]
]) {
  const nodes = Array.from({ length: fileCount + directoryCount }, (_, index) => ({
    name: `item-${index}`,
    path: `/repo/item-${index}`,
    relativePath: `item-${index}`,
    isDirectory: index >= fileCount,
    depth: 0
  }))
  const expected = original(nodes)
  const actual = selectDeletionRoots(nodes)
  assert.equal(actual.length, expected.length)
  actual.forEach((node, index) => assert.equal(node, expected[index]))
  results.push({
    fileCount,
    directoryCount,
    beforeMs: measure(original, nodes),
    afterMs: measure(selectDeletionRoots, nodes)
  })
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2))
