import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createUninstallFixture,
  latestPluginLog,
  latestUninstallWorker,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures,
  uninstallWorkerPorts
} from '../../../src/main/plugins/__mocks__/plugin-uninstall-log-test-fixture'

const require = createRequire(import.meta.url)
const { loadSources, sha256, readText } = require('./sources.cjs')
const loaded = loadSources()
const fixed = loaded.variant === 'fixed'
const observations = []
beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)
afterAll(() => {
  const directory = 'docs/audits/plugin-uninstall-log-retirement'
  const artifactHashes = Object.fromEntries(
    [
      'sources.cjs',
      'scenario.test.mjs',
      'phase.config.mjs',
      'source-versions.json',
      'fix.patch',
      'dependency-context.patch'
    ].map((name) => [name, sha256(readText(resolve(directory, name)))])
  )
  writeFileSync(
    process.env.ORCA_PLUGIN_LOG_OUTPUT ??
      resolve(
        directory,
        `${loaded.variant}-${process.versions.electron ? 'electron' : 'node'}-results.json`
      ),
    `${JSON.stringify({ runtime: { node: process.versions.node, electron: process.versions.electron ?? null, v8: process.versions.v8, platform: process.platform, arch: process.arch }, variant: loaded.variant, selectedNamedBase: loaded.versions.mainRef, selectedProducts: 8, evaluatedSourcePolicy: 'Eight selected products at named main baseline, with the explicitly fenced current dependency context.', artifactHashes, sourceHashes: loaded.hashes, observations }, null, 2)}\n`
  )
})

it('measures removed log rows while eight old worker callback ports remain rooted', async () => {
  const { service, install } = await createUninstallFixture()
  const keys = [],
    refs = []
  for (let index = 0; index < 8; index += 1) {
    const key = await install(`retired-${index}`)
    keys.push(key)
    expect(service.getLogs(key)).toHaveLength(200)
    refs.push(new WeakRef(latestPluginLog(service, key)))
    await removeThroughPluginIpc(key)
    expect(service.findValidPlugin(key)).toBeNull()
    expect(service.getLogs(key)).toHaveLength(fixed ? 0 : 200)
  }
  if (!global.gc) {
    throw new Error('Run with --expose-gc')
  }
  for (let index = 0; index < 6; index += 1) {
    await new Promise((done) => setImmediate(done))
    global.gc()
  }
  const observed = {
    control: 'eight-successful-uninstalls',
    retainedKeys: keys.filter((key) => service.getLogs(key).length).length,
    retainedRows: keys.reduce((sum, key) => sum + service.getLogs(key).length, 0),
    rowsAlive: refs.filter((ref) => ref.deref()).length,
    callbackPorts: uninstallWorkerPorts.length,
    connectedPorts: uninstallWorkerPorts.filter((port) => port.connected).length
  }
  expect(observed).toMatchObject({
    retainedKeys: fixed ? 0 : 8,
    retainedRows: fixed ? 0 : 1600,
    rowsAlive: fixed ? 0 : 8,
    callbackPorts: 8,
    connectedPorts: 0
  })
  observations.push(observed)
})

it('preserves installed stopped history and measures old callback pollution after reinstall', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('reused')
  await service.deactivatePlugin(key)
  expect(service.getLogs(key)).toHaveLength(200)
  const old = latestUninstallWorker()
  await removeThroughPluginIpc(key)
  await install('reused')
  old.emitLateLog('controlled-old-worker-callback')
  const lastRow = latestPluginLog(service, key).line
  expect(lastRow).toBe(fixed ? 'log-204' : 'controlled-old-worker-callback')
  observations.push({
    control: 'identical-reinstall',
    installedStoppedRows: 200,
    successorConnected: latestUninstallWorker().connected,
    staleLogAccepted: !fixed,
    lastRow
  })
})

it('measures final stdout tail publication after worker exit and successful uninstall', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('stdio')
  const child = latestUninstallWorker()
  child.stdout.write('controlled-late-stdio-tail')
  await removeThroughPluginIpc(key)
  expect(child.connected).toBe(false)
  child.stdout.end()
  await new Promise((done) => setImmediate(done))
  const lastRow = service.getLogs(key).at(-1)?.line ?? null
  expect(lastRow).toBe(fixed ? null : 'controlled-late-stdio-tail')
  observations.push({
    control: 'exit-before-stdio-end',
    lastRow,
    retainedRows: service.getLogs(key).length
  })
})

it('preserves installed SDK row bounds and malformed worker message handling', async () => {
  const { service, install } = await createUninstallFixture()
  const key = await install('bounds')
  const child = latestUninstallWorker()
  child.emitSdkLog('x'.repeat(16384))
  expect(latestPluginLog(service, key).line).toHaveLength(8192)
  child.emitLateLog('x'.repeat(16384))
  expect(latestPluginLog(service, key).line).toBe('ignoring malformed worker message')
  expect(service.getLogs(key)).toHaveLength(200)
  observations.push({
    control: 'unchanged-row-and-ipc-bounds',
    sdkCodeUnits: 8192,
    rows: 200,
    malformedRawIpcRejected: true
  })
})
