const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { realpathSync } = require('node:fs')
const { join } = require('node:path')
const Module = require('node:module')

require('tsx/cjs')
const directory = process.argv[2]
const mode = process.argv[3]
process.argv[1] = join(directory, 'orcad.js')

// Source tests have no bundled worker; keep production fork/IPC and substitute only its entry path.
const load = Module._load
Module._load = function (request, ...args) {
  const result = load.call(this, request, ...args)
  return request.endsWith('worker-thread-entry-path')
    ? { ...result, resolveWorkerThreadEntryPath: () => join(directory, 'worker-thread-child-process-entry.js') }
    : result
}

const { startOrcadWithLifecycle } = require('../orcad-lifecycle.ts')
const { canonicalizePathThroughFilesystemHost, readOrcaYamlThroughFilesystemHost,
  requireFilesystemHostReadClient } = require('../../filesystem-host/filesystem-host-read-client.ts')
const { resolveAuthorizedPath } = require('../../ipc/filesystem/filesystem-auth.ts')
const { partialRuntimeStore, storeRepo } = require('../../runtime/runtime-store-partial-fixture.ts')
const { runProcess } = require('@orca/process-host')

async function main() {
  assert.throws(requireFilesystemHostReadClient, /unavailable/)
  if (mode === 'qualification-child') {
    const { preflightOrcadNativeRuntime } = require('../orcad-runtime-native-preflight.ts')
    await preflightOrcadNativeRuntime({ nativeFeatures: false })
    const { disposeFilesystemHost } = require('../../filesystem-host/filesystem-host-lifetime.ts')
    await disposeFilesystemHost()
    return
  }
  if (mode === 'ordinary') {
    const qualified = await runProcess({
      program: process.execPath,
      args: ['--conditions=orca-source', __filename, directory, 'qualification-child'],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 10000,
      terminationBarrier: true
    })
    assert.equal(qualified.code, 0, qualified.stderr)
    assert.throws(requireFilesystemHostReadClient, /unavailable/)
  }
  const file = join(directory, 'notes.txt')
  await writeFile(file, 'folder workspace file')
  const yaml = join(directory, 'orca.yaml')
  await writeFile(yaml, 'setup:\n  - echo ready\n')
  const store = partialRuntimeStore({
    getRepos: () => [storeRepo({ id: 'folder', path: directory, kind: 'folder' })]
  })
  let cleaned = false
  const probe = async () => {
    assert.equal(await canonicalizePathThroughFilesystemHost(directory), realpathSync(directory))
    const allowed = await resolveAuthorizedPath(file, store)
    assert.equal(await readFile(allowed, 'utf8'), 'folder workspace file')
    await assert.rejects(resolveAuthorizedPath(join(directory, '..', 'outside.txt'), store), /Access denied/)
    assert.equal(await readOrcaYamlThroughFilesystemHost(yaml), 'setup:\n  - echo ready\n')
  }
  if (mode === 'failed-startup') {
    await assert.rejects(startOrcadWithLifecycle(async () => {
      await probe()
      throw new Error('later startup failed')
    }, async () => { cleaned = true }), /later startup failed/)
  } else {
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      await probe()
      registerCleanup(async () => { await probe() })
      return {}
    }, async () => { cleaned = true })
    await handle.stop()
  }
  assert.equal(cleaned, true)
  assert.throws(requireFilesystemHostReadClient, /unavailable/)
  console.log('filesystem serving lifetime passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
