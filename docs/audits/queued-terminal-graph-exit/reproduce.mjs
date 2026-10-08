import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startVitest } from 'vitest/node'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const paths = [
  'src/main/runtime/orca-runtime-sync-window-graph.ts',
  'src/main/runtime/orca-runtime-mark-pty-liveness-unverifiable.ts',
  'src/main/runtime/orca-runtime-on-pty-exit.ts'
]
const sources = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))
const gate = `      // Retained history stays addressable, but a renderer graph cannot revoke a host-certified exit.
      const connected = ptyId !== null && this.getPtyLivenessVerdict(ptyId)?.status !== 'exited'
`
const preserve = `    // An inventory's weak absence cannot revoke an earlier host-certified exit.
    if (tracked?.verdict.status === 'exited') {
      return
    }
`
const certificate = `    if (processDeathCertified) {
      // The bounded verdict register also fences late graphs after the PTY record was pruned.
      this.rememberPtyLivenessVerdict(ptyId, { status: 'exited' })
    }
`
for (const [index, text] of [gate, preserve, certificate].entries()) {
  assert(sources[index].includes(text), 'Source changed: review the baseline transform.')
}
const baseline = [
  sources[0]
    .replace(gate, '')
    .replace(
      "        connected,\n        writable: this.graphStatus === 'ready' && connected,",
      "        connected: ptyId !== null,\n        writable: this.graphStatus === 'ready' && ptyId !== null,"
    )
    .replace('      if (leaf.ptyId && connected) {', '      if (leaf.ptyId) {'),
  sources[1].replace(preserve, ''),
  sources[2].replace(certificate, '').replace(
    '      pty.lastExitCause = exitCause\n',
    `      pty.lastExitCause = exitCause
      if (exitCode >= 0 || options.hostExitConfirmed === true) {
        this.rememberPtyLivenessVerdict(ptyId, { status: 'exited' })
      }
`
  )
]
const scratch = await mkdtemp(join(tmpdir(), 'orca-queued-graph-proof-'))
const phases = []
try {
  for (const phase of ['before', 'guard-only', 'after']) {
    const outputPath = join(scratch, `${phase}.json`)
    const testPath = join(scratch, `${phase}.test.ts`)
    const configPath = join(scratch, `${phase}.config.mjs`)
    await writeFile(
      testPath,
      `
import { afterAll, it } from ${JSON.stringify(join(root, 'node_modules/vitest/dist/index.js'))}
import { writeFileSync } from 'node:fs'
import { runQueuedGraphExitScenario } from ${JSON.stringify(join(root, 'docs/audits/queued-terminal-graph-exit/fixture.ts'))}
import { runPreservedHistoryScenario } from ${JSON.stringify(join(root, 'docs/audits/queued-terminal-graph-exit/preserved-history-fixture.ts'))}
const rows = []
let history
it("preserved history", async () => { history = await runPreservedHistoryScenario() })
for (const successor of [false, true]) {
  for (const graphGapBeforeInventory of [false, true]) {
    it(String(successor) + String(graphGapBeforeInventory), async () => rows.push(await runQueuedGraphExitScenario(successor, graphGapBeforeInventory)))
  }
}
afterAll(() => writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ rows, history })))
`
    )
    const replacements = Object.fromEntries(
      paths.map((path, index) => [
        `/${path}`,
        phase === 'after' || (phase === 'guard-only' && index === 0)
          ? sources[index]
          : baseline[index]
      ])
    )
    await writeFile(
      configPath,
      `
import base from ${JSON.stringify(pathToFileURL(join(root, 'config/vitest.config.ts')).href)}
const replacements = ${JSON.stringify(replacements)}
export default {
  ...base,
  plugins: [{ name: 'graph-exit-baseline', enforce: 'pre', transform(code, id) {
    for (const [path, replacement] of Object.entries(replacements)) {
      if (id.replaceAll('\\\\', '/').endsWith(path)) return replacement
    }
  } }],
  test: { ...base.test, include: [${JSON.stringify(testPath)}], maxWorkers: 1, fileParallelism: false }
}
`
    )
    const runner = await startVitest('test', [], {
      root,
      config: configPath,
      watch: false,
      reporters: ['dot']
    })
    assert(runner, 'Vitest did not start')
    await runner.close()
    const { rows, history } = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(history.afterQueued.length, 1)
    assert.equal(history.afterBindingClear.length, 1)
    assert.equal(history.model, false)
    if (phase !== 'before') {
      assert.equal(history.leafState.connected, false)
      assert.equal(history.leafState.writable, false)
    }
    delete history.incoming.publicationEpoch
    assert.equal(rows.length, 4)
    for (const row of rows) {
      const successor = row.scenario === 'successor-binding-before-exit'
      assert.equal(row.afterExit.connected, false)
      assert.equal(row.afterQueuedGraph.connected, successor && phase === 'before')
      assert.equal(
        row.afterRepeatedGraph.connected,
        successor && (phase === 'before' || (phase === 'guard-only' && row.graphGapBeforeInventory))
      )
      assert.equal(
        row.resolution === 'terminal_pane_owner_conflict',
        successor && phase === 'before'
      )
      assert.equal(row.inventory.length, successor ? 1 : 0)
      assert.equal(row.afterRepeatedGraph.model, false)
      if (phase === 'after') {
        assert.equal(row.afterRepeatedGraph.urlBound, false)
        assert(row.afterRepeatedGraph.leaves.every((leaf) => !leaf.connected && !leaf.writable))
        assert(row.mobile.every((tab) => !tab.handlePtyId || tab.ptyId === tab.handlePtyId))
      }
      for (const state of [
        row.afterExit,
        row.afterQueuedGraph,
        row.afterFreshList,
        row.afterRepeatedGraph
      ]) {
        delete state.incarnationId
      }
      delete row.capture.rendererGeneration
      if (row.resolution && typeof row.resolution === 'object') {
        row.resolution = { ptyId: row.resolution.ptyId }
      }
      row.inventory = row.inventory.map(({ id }) => ({ id }))
    }
    phases.push({ phase, rows, history })
  }
  const output = `${JSON.stringify(
    {
      sources: Object.fromEntries(
        paths.map((path, index) => [
          path,
          createHash('sha256').update(sources[index]).digest('hex')
        ])
      ),
      phases
    },
    null,
    2
  )}\n`
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), output)
  }
  process.stdout.write(output)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
