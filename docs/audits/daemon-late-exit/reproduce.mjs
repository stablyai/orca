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
const sourcePath = join(root, 'src/main/ipc/pty/provider/bind-listeners.ts')
const source = await readFile(sourcePath, 'utf8')
const declaration =
  '      const syntheticExit = session.consumeSyntheticKillExit(payload.id, payload.incarnationId)'
const notificationFence =
  '      // The control reply can overtake stream data; the physical exit must retire that late output.\n' +
  '      if (syntheticExit) {\n        return\n      }'
const restoreIntent =
  '        if (syntheticExit) {\n          session.runtime?.markPtyStopRequested(payload.id)\n        }\n'
for (const boundary of [declaration, notificationFence, restoreIntent]) {
  assert(source.includes(boundary), 'Source changed: review the baseline transform.')
}
const before = source
  .replace(notificationFence, '')
  .replace(restoreIntent, '')
  .replace(declaration, `${declaration}\n      if (syntheticExit) {\n        return\n      }`)
const fixturePath = join(root, 'src/main/ipc/pty/daemon-late-exit-test-fixture.ts')
const scratch = await mkdtemp(join(tmpdir(), 'orca-daemon-late-exit-proof-'))
const phases = []
try {
  for (const phase of ['before', 'after']) {
    const resultPath = join(scratch, `${phase}.json`)
    const testPath = join(scratch, `${phase}.test.ts`)
    const configPath = join(scratch, `${phase}.config.mjs`)
    await writeFile(
      testPath,
      `
import { afterAll, it } from ${JSON.stringify(join(root, 'node_modules/vitest/dist/index.js'))}
import { writeFileSync } from 'node:fs'
import { startLateExitHarness } from ${JSON.stringify(fixturePath)}
const rows = []
for (const scenario of ['queued-data', 'verified-stop', 'no-queued-data', 'natural-exit']) {
  it(scenario, async () => {
    const harness = await startLateExitHarness()
    try {
      if (scenario !== 'natural-exit') harness.pauseStream()
      if (scenario !== 'no-queued-data') harness.subprocess._simulateData('final output\\r\\n')
      if (scenario === 'natural-exit') harness.subprocess._simulateExit(0)
      else if (scenario === 'verified-stop') { if (!await harness.stopAndWait()) throw new Error('Stop was not verified') }
      else await harness.kill()
      const beforeDrain = harness.runtime.captureState()
      harness.resumeStream()
      await harness.waitForExit()
      const result = await harness.capture()
      delete result.incarnationId
      delete beforeDrain.incarnationId
      rows.push({ scenario, beforeDrain, afterDrain: result })
    } finally { await harness.dispose() }
  })
}
afterAll(() => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(rows)))
`
    )
    await writeFile(
      configPath,
      `
import base from ${JSON.stringify(pathToFileURL(join(root, 'config/vitest.config.ts')).href)}
export default {
  ...base,
  plugins: [{ name: 'late-exit-baseline', enforce: 'pre', transform(code, id) {
    if (${JSON.stringify(phase)} === 'before' && id.replaceAll('\\\\', '/').endsWith('/src/main/ipc/pty/provider/bind-listeners.ts')) return ${JSON.stringify(before)}
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
    const samples = JSON.parse(await readFile(resultPath, 'utf8'))
    assert.equal(samples.length, 4)
    for (const sample of samples) {
      const leaked =
        phase === 'before' && ['queued-data', 'verified-stop'].includes(sample.scenario)
      assert.equal(sample.afterDrain.connected, leaked)
      assert.equal(sample.afterDrain.headlessModelRetained, leaked)
      assert.equal(sample.afterDrain.titleTrackerRetained, leaked)
      assert.equal(sample.afterDrain.providerHasPty, false)
      assert.equal(sample.afterDrain.hostInventoryCount, 0)
      assert.equal(sample.afterDrain.rendererExitCount, 1)
      assert.equal(sample.afterDrain.providerExitCount, 1)
      assert.equal(sample.afterDrain.exitListenerCalls, 1)
      assert.deepEqual(
        sample.afterDrain.deliveredData,
        sample.scenario === 'no-queued-data' ? [] : ['final output\r\n']
      )
    }
    phases.push({ phase, samples })
  }
  const results = {
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    baselineTransform:
      'Restore duplicate suppression before provider/runtime cleanup only; keep current incarnation-fenced markers.',
    phases
  }
  const output = `${JSON.stringify(results, null, 2)}\n`
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), output)
  }
  process.stdout.write(output)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
