'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const pty = require('node-pty')
const utilsPath = require.resolve('node-pty/lib/utils')
const loaded = require(utilsPath).loadNativeModule('conpty')
const native = loaded.module
const [operation, fence] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.ok(operation === 'kill' || operation === 'destroy')
assert.ok(fence === 'immediate' || fence === 'connected')
assert.equal(native.assignCurrentProcessToJob(), true, 'Host crash cleanup must own descendants')

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function exercise() {
  const { createStressObserver, loadedStressInputHashes } =
    await import('./windows-pty-table-stress-observer.mjs')
  const processTree = require('@vscode/windows-process-tree')
  const {
    assertWindowsProcessTreeCreationTime
  } = require('./windows-process-tree-creation-time.cjs')
  assertWindowsProcessTreeCreationTime({ module: processTree })
  const processTreeEntry = require.resolve('@vscode/windows-process-tree')
  const identityInputs = [
    processTreeEntry,
    resolve(dirname(processTreeEntry), '..', 'build', 'Release', 'windows_process_tree.node'),
    require.resolve('./windows-process-tree-creation-time.cjs')
  ].map((path) => {
    const bytes = readFileSync(path)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const addonPath = resolve(dirname(utilsPath), loaded.dir, 'conpty.node')
  writeSync(
    1,
    `${JSON.stringify({
      phase: 'inputs',
      node: process.version,
      inputs: loadedStressInputHashes(addonPath, require.resolve),
      identityInputs
    })}\n`
  )
  const term = pty.spawn(
    process.execPath,
    ['-e', 'process.stdin.resume();setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      useConpty: true,
      useConptyDll: true,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
  )
  let dataCallbacks = 0
  let exitCallbacks = 0
  const unexpectedExits = []
  let nativeExitCallbacks = 0
  const record = {
    proc: term,
    exited: false,
    get closed() {
      return term._killRequested === true
    }
  }
  const observer = createStressObserver((phase, details) => {
    if (phase === 'native-exit-callback') {
      nativeExitCallbacks += 1
    }
    writeSync(1, `${JSON.stringify({ phase, ...details })}\n`)
  })
  term.onData(() => {
    dataCallbacks += 1
  })
  term.onExit((event) => {
    if (
      nativeExitCallbacks !== 1 ||
      !Number.isInteger(event.exitCode) ||
      event.exitCode !== term._agent.exitCode
    ) {
      unexpectedExits.push({
        nativeExitCallbacks,
        exitCode: event.exitCode ?? null,
        nativeExitCode: term._agent.exitCode ?? null
      })
    }
    exitCallbacks += 1
    record.exited = true
  })
  observer.watch(record, { round: 0, slot: 0 })
  const pid = term.pid
  const originalCreationTimeMs = processTree.getProcessCreationTime(pid) ?? null
  writeSync(1, `${JSON.stringify({ phase: 'child-incarnation', pid, originalCreationTimeMs })}\n`)
  assert.ok(
    Number.isSafeInteger(originalCreationTimeMs) && originalCreationTimeMs > 0,
    'The actual child creation time must be readable before teardown'
  )
  function reportFence(stage) {
    writeSync(
      1,
      `${JSON.stringify({
        phase: 'fence',
        stage,
        operation,
        fence,
        pid,
        dataCallbacks,
        inputDestroyed: term._agent.inSocket.destroyed
      })}\n`
    )
  }
  assert.ok(Number.isInteger(pid) && pid > 0)
  assert.equal(alive(pid), true)
  assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
  assert.equal(dataCallbacks, 0)
  term.write('queued input')

  const connected = new Promise((resolve, reject) => {
    // Observe the real forwarding connection; do not suppress or fabricate output.
    term._socket.once('ready_datapipe', () => {
      try {
        assert.equal(dataCallbacks, 0, 'The fence must precede delivered first data')
        reportFence('forwarding-connected')
        if (fence === 'connected') {
          assert.equal(alive(pid), true)
          assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
          reportFence('before-public-teardown')
          term[operation]()
          reportFence('after-public-teardown')
        }
        // This is actual pipe retirement; old queued teardown leaves it open here.
        reportFence('pre-first-data-retirement')
        assert.equal(
          term._agent.inSocket.destroyed,
          true,
          'Public teardown must retire the actual input pipe at forwarding connection before first data'
        )
        term[operation]()
        term.write('retired input')
        term.resize(81, 24)
        term.clear()
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  if (fence === 'immediate') {
    reportFence('before-public-teardown')
    term[operation]()
    reportFence('after-public-teardown')
    term[operation]()
  }
  const deadline = Date.now() + 15_000
  let timeout
  try {
    await Promise.race([
      connected,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Forwarding connection did not arrive')),
          15_000
        )
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
  while ((alive(pid) || exitCallbacks === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const currentCreationTimeMs = processTree.getProcessCreationTime(pid) ?? null
  writeSync(
    1,
    `${JSON.stringify({
      phase: 'retirement-state',
      operation,
      fence,
      pid,
      originalCreationTimeMs,
      currentCreationTimeMs,
      incarnation:
        Number.isSafeInteger(currentCreationTimeMs) && currentCreationTimeMs > 0
          ? currentCreationTimeMs === originalCreationTimeMs
            ? 'same'
            : 'different'
          : 'unverifiable',
      pidIsAlive: alive(pid),
      ownedJobProcessIds: native.listJobProcessIds(term._pty, pid) ?? null,
      nativeExitCallbacks,
      nativeExitCode: Number.isInteger(term._agent.exitCode) ? term._agent.exitCode : null,
      publicExitCallbacks: exitCallbacks,
      unexpectedExits,
      dataCallbacks,
      inputDestroyed: term._agent.inSocket.destroyed,
      outputDestroyed: term._socket.destroyed,
      pipeReady: term._isPipeReady === true,
      firstDataReady: term._isReady === true,
      killRequested: term._killRequested === true,
      killReturned: term._killComplete === true
    })}\n`
  )
  assert.equal(alive(pid), false, 'Public teardown must kill the real child')
  assert.equal(exitCallbacks, 1, 'Actual public exit must arrive exactly once')
  assert.deepEqual(
    unexpectedExits,
    [],
    'Requested ConPTY teardown must publish the actual native acknowledgment and exit code'
  )
  writeSync(1, `${JSON.stringify({ phase: 'complete', operation, fence, pid, exitCallbacks })}\n`)
}

exercise().catch((error) => {
  writeSync(2, `${error.stack}\n`)
  process.exitCode = 1
})
