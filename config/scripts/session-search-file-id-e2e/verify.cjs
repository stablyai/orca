const assert = require('node:assert/strict')

const { readFileSync, writeFileSync } = require('node:fs')

const { join, resolve } = require('node:path')

const { createHash } = require('node:crypto')

const { transformSync } = require('esbuild')

const evidence = resolve('notes/search-ipc')

const json = (path) => JSON.parse(readFileSync(path, 'utf8'))

const red = json(join(evidence, 'red-latest.json')).output

const green = json(join(evidence, 'green-latest.json')).output

const before = json(join(red, 'topology.json'))

const after = json(join(green, 'topology.json'))

assert.equal(before.wiring, after.wiring)

assert.deepEqual(before.injections, after.injections)

const oldFiles = new Map(before.files.map((row) => [row.path, row.sha256]))

assert.equal(oldFiles.size, after.files.length)

const changed = after.files
  .filter((row) => oldFiles.get(row.path) !== row.sha256)
  .map((row) => row.path)
  .sort()

assert.deepEqual(changed, [
  '/src/main/ai-vault-search/session-search-index-writer.ts',
  '/src/main/ai-vault-search/session-search-store.ts'
])

for (const name of ['host.cjs', 'client.cjs']) {
  // Ignore formatter-only differences; preserve every expression and assertion.
  const hash = (root) =>
    createHash('sha256')
      .update(
        transformSync(readFileSync(join(root, name), 'utf8'), {
          loader: 'js',
          minifyWhitespace: true
        }).code
      )
      .digest('hex')

  assert.equal(hash(red), hash(green), `Identical oracle: ${name}`)
}

const failed = json(join(red, 'report-lifecycle.json'))

assert.equal(failed.ok, false)

assert.match(failed.stderr.join(''), /RangeError: Value is too large/)

assert.ok(failed.stages.some((row) => row.stage === 'initial-indexing'))

const reports = [
  json(join(green, 'report-lifecycle.json')),
  json(join(green, 'report-restart.json'))
]

for (const report of reports) {
  assert.equal(report.ok, true)
  assert.ok(report.ipc.some((row) => row.operation === 'searchSessions'))
  assert.ok(report.stages.some((row) => row.stage === 'query' && row.clientPid !== report.pid))
  assert.ok(report.children.every((child) => child.exitCode === 0))
}

assert.notEqual(reports[0].pid, reports[1].pid)

const result = {
  ok: true,
  wiring: before.wiring,
  changed,
  red,
  green,
  parentPids: [failed.pid, ...reports.map((row) => row.pid)],
  childPids: [failed, ...reports].flatMap((report) => report.children.map((child) => child.pid))
}

writeFileSync(join(evidence, 'comparison.json'), JSON.stringify(result, null, 2))

console.log(JSON.stringify(result))
