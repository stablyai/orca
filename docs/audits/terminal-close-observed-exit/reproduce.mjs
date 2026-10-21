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
const sourcePath = 'src/main/runtime/orca-runtime-stop-explicitly-closed-tab-ptys.ts'
const fixturePath = 'src/main/runtime/terminal-close-observed-exit-test-fixture.ts'
const source = await readFile(join(root, sourcePath), 'utf8')
const capture = '      const expectedIncarnationId = this.ptysById.get(ptyId)?.incarnationId\n'
const guard = `        // Preserve an observed exit when a broader inventory check could not finish.
        if (
          !stopped &&
          expectedIncarnationId &&
          this.ptysById.get(ptyId)?.incarnationId === expectedIncarnationId &&
          this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
        ) {
          stopped = true
        }
`
assert(source.includes(capture) && source.includes(guard), 'Review the baseline transform.')
const baseline = source.replace(capture, '').replace(guard, '')
const scratch = await mkdtemp(join(tmpdir(), 'orca-observed-exit-proof-'))
const phases = []
try {
  for (const phase of ['before', 'after']) {
    const testPath = join(scratch, `${phase}.test.ts`)
    const outputPath = join(scratch, `${phase}.json`)
    const configPath = join(scratch, `${phase}.config.mjs`)
    await writeFile(
      testPath,
      `
import { afterAll, it } from ${JSON.stringify(join(root, 'node_modules/vitest/dist/index.js'))}
import { writeFileSync } from 'node:fs'
import { runObservedExitSocketScenario, runObservedExitControl } from ${JSON.stringify(join(root, fixturePath))}
const sockets = []
const controls = []
for (const scenario of ['healthy', 'unrelated-endpoint-gone', 'physical-exit-observed']) {
  it(scenario, async () => sockets.push(await runObservedExitSocketScenario(scenario)))
}
for (const control of ['same-incarnation', 'replacement', 'unverified', 'legacy-unstamped', 'throw-after-exit']) {
  it(control, async () => controls.push(await runObservedExitControl(control)))
}
afterAll(() => writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ sockets, controls })))
`
    )
    await writeFile(
      configPath,
      `
import base from ${JSON.stringify(pathToFileURL(join(root, 'config/vitest.config.ts')).href)}
export default {
  ...base,
  plugins: [{ name: 'observed-exit-baseline', enforce: 'pre', transform(code, id) {
    if (id.replaceAll('\\\\', '/').endsWith(${JSON.stringify(`/${sourcePath}`)})) return ${JSON.stringify(phase === 'before' ? baseline : source)}
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
    const result = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(result.sockets.length, 3)
    assert.equal(result.controls.length, 5)
    for (const row of result.sockets) {
      const observed = row.scenario === 'physical-exit-observed'
      const healthy = row.scenario === 'healthy'
      assert.equal(row.close.ptyKilled, healthy || (observed && phase === 'after'))
      assert.equal(row.fallbackKills, healthy || (observed && phase === 'after') ? 0 : 1)
      assert.equal(row.targetInventoryCount, 0)
      assert.equal(row.targetProbe, false)
      assert.equal(row.routerProbe, healthy ? false : null)
      assert.equal(row.settled.connected, false)
      assert.equal(row.settled.headlessModelRetained, false)
      assert.equal(row.settled.providerExitCount, 1)
      assert.equal(row.settled.exitListenerCalls, 1)
      if (observed) {
        assert.deepEqual(
          row.settled.exitCause,
          phase === 'after'
            ? { kind: 'operator_close' }
            : { kind: 'unknown', reason: 'stop_unverified' }
        )
        assert.equal(row.settled.rendererExitCount, phase === 'after' ? 1 : 2)
      }
      if (!healthy && !observed) {
        assert.equal(row.close.ptyStopVerdict, 'unverifiable')
        assert.equal(row.beforeStreamResume.providerExitCount, 0)
      }
      delete row.beforeStreamResume.incarnationId
      delete row.settled.incarnationId
    }
    for (const row of result.controls) {
      const accepts = phase === 'after' && row.scenario === 'same-incarnation'
      assert.equal(row.stopped, accepts)
      assert.equal(row.fallbackKills, accepts ? 0 : 1)
    }
    phases.push({ phase, ...result })
  }
  const output = `${JSON.stringify(
    {
      sourceHashes: {
        before: createHash('sha256').update(baseline).digest('hex'),
        after: createHash('sha256').update(source).digest('hex'),
        fixture: createHash('sha256')
          .update(await readFile(join(root, fixturePath)))
          .digest('hex')
      },
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
