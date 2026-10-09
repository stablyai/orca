'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const pty = require('node-pty')
const utilsPath = require.resolve('node-pty/lib/utils')
const loaded = require(utilsPath).loadNativeModule('conpty')
const native = loaded.module
const [backend, faultMode] = process.argv.slice(2)
assert.equal(process.platform, 'win32')
assert.ok(backend === 'dll' || backend === 'inbox')
assert.ok(faultMode === undefined || faultMode === 'retry')
const retryFault = faultMode === 'retry'
assert.equal(native.assignCurrentProcessToJob(), true, 'Host crash cleanup must own descendants')

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function report(phase, details) {
  writeSync(1, `${JSON.stringify({ phase, ...details })}\n`)
}

async function exercise() {
  const { createStressObserver, loadedStressInputHashes } =
    await import('./windows-pty-table-stress-observer.mjs')
  const processTree = require('@vscode/windows-process-tree')
  const {
    assertWindowsProcessTreeCreationTime
  } = require('./windows-process-tree-creation-time.cjs')
  assertWindowsProcessTreeCreationTime({ module: processTree })
  const addonPath = resolve(dirname(utilsPath), loaded.dir, 'conpty.node')
  const extraInputs = [
    require.resolve('node-pty/lib/windowsConoutConnection'),
    require.resolve('node-pty/lib/worker/conoutSocketWorker'),
    require.resolve('@vscode/windows-process-tree')
  ].map((path) => {
    const bytes = readFileSync(path)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  report('inputs', {
    backend,
    node: process.version,
    inputs: loadedStressInputHashes(addonPath, require.resolve),
    extraInputs
  })
  const term = pty.spawn(
    process.execPath,
    ['-e', 'process.stdin.resume();setInterval(() => {}, 1000)'],
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      useConpty: true,
      useConptyDll: backend === 'dll',
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    }
  )
  const pid = term.pid
  let dataCallbacks = 0
  let exitCallbacks = 0
  const unexpectedExits = []
  let nativeExitCallbacks = 0
  let forwardingConnections = 0
  let faultApplied = false
  const errors = []
  const unhandledRejections = []
  let firstKillFault = false
  let retried = false
  const record = {
    proc: term,
    exited: false,
    get closed() {
      return term._killRequested === true
    }
  }
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
  if (retryFault) {
    assert.equal(term.listeners('error').length, 1, 'Only the constructor error listener may exist')
    process.on('unhandledRejection', (error) => {
      unhandledRejections.push(String(error))
      report('unhandled-cleanup-rejection', { error: String(error) })
    })
    const originalKill = term._agent.kill.bind(term._agent)
    term._agent.kill = () => {
      if (!firstKillFault) {
        firstKillFault = true
        report('injected-first-kill-failure', { pid })
        throw new Error('ORCA_FIRST_PRECONNECT_KILL_FAILURE')
      }
      originalKill()
    }
  } else {
    term.on('error', (error) => {
      errors.push(String(error))
      report('terminal-error', { error: String(error) })
    })
  }
  const observer = createStressObserver((phase, details) => {
    if (phase === 'native-exit-callback') {
      nativeExitCallbacks += 1
    }
    report(phase, details)
  })
  observer.watch(record, { round: 0, slot: 0 })
  term._socket.on('ready_datapipe', () => {
    forwardingConnections += 1
  })
  const originalCreationTimeMs = processTree.getProcessCreationTime(pid) ?? null
  assert.ok(Number.isSafeInteger(originalCreationTimeMs) && originalCreationTimeMs > 0)
  assert.equal(alive(pid), true)
  assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
  report('child-incarnation', { pid, originalCreationTimeMs })
  // The Agent's earlier listener starts the real connection before this resource fault.
  term._agent._conoutSocketWorker.onReady(() => {
    assert.equal(term._isPipeReady, false, 'The resource fault must precede forwarding readiness')
    assert.equal(dataCallbacks, 0, 'The resource fault must precede delivered output')
    report('before-closed-forwarding-teardown', { pid, dataCallbacks, forwardingConnections })
    term.destroy()
    term._socket.destroy()
    faultApplied = true
    report('closed-forwarding-teardown', {
      pid,
      outputDestroyed: term._socket.destroyed,
      killRequested: term._killRequested === true
    })
  })
  const deadline = Date.now() + 15_000
  while ((!faultApplied || alive(pid) || exitCallbacks === 0) && Date.now() < deadline) {
    if (retryFault && firstKillFault && !retried) {
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(processTree.getProcessCreationTime(pid), originalCreationTimeMs)
      assert.equal(alive(pid), true, 'The failed first kill must leave the actual child live')
      assert.ok(native.listJobProcessIds(term._pty, pid)?.includes(pid))
      assert.equal(nativeExitCallbacks, 0)
      assert.equal(exitCallbacks, 0)
      retried = true
      report('retry-after-first-kill-failure', { pid, nativeExitCallbacks, exitCallbacks })
      term.destroy()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const currentCreationTimeMs = processTree.getProcessCreationTime(pid) ?? null
  report('retirement-state', {
    backend,
    pid,
    originalCreationTimeMs,
    currentCreationTimeMs,
    incarnation:
      Number.isSafeInteger(currentCreationTimeMs) && currentCreationTimeMs > 0
        ? currentCreationTimeMs === originalCreationTimeMs
          ? 'same'
          : 'different'
        : 'unverifiable',
    faultApplied,
    pidIsAlive: alive(pid),
    ownedJobProcessIds: native.listJobProcessIds(term._pty, pid) ?? null,
    nativeExitCallbacks,
    nativeExitCode: Number.isInteger(term._agent.exitCode) ? term._agent.exitCode : null,
    publicExitCallbacks: exitCallbacks,
    unexpectedExits,
    forwardingConnections,
    dataCallbacks,
    inputDestroyed: term._agent.inSocket.destroyed,
    outputDestroyed: term._socket.destroyed,
    pipeReady: term._isPipeReady === true,
    firstDataReady: term._isReady === true,
    killRequested: term._killRequested === true,
    killReturned: term._killComplete === true,
    errors,
    retryFault,
    firstKillFault,
    retried,
    unhandledRejections
  })
  assert.equal(faultApplied, true, 'The actual worker-ready resource fault must be reached')
  assert.equal(forwardingConnections, 0, 'A retired forwarding connection must not reopen')
  assert.equal(alive(pid), false, 'Closed-forwarding public teardown must kill the real child')
  assert.equal(
    nativeExitCallbacks,
    1,
    'The actual native exit acknowledgment must arrive exactly once'
  )
  assert.equal(exitCallbacks, 1, 'Actual public exit must arrive exactly once')
  assert.deepEqual(
    unexpectedExits,
    [],
    'Requested ConPTY teardown must publish the actual native acknowledgment and exit code'
  )
  assert.equal(term._agent.inSocket.destroyed, true)
  assert.deepEqual(errors, [])
  if (retryFault) {
    assert.equal(firstKillFault, true, 'The actual first kill failure must be reached')
    assert.equal(retried, true, 'Public teardown must retry the failed native cleanup')
    assert.deepEqual(
      unhandledRejections,
      [],
      'Cleanup failure must not create an unhandled rejection'
    )
  }
  report('complete', { backend, pid, nativeExitCallbacks, exitCallbacks, retryFault })
}

exercise().catch((error) => {
  writeSync(2, `${error.stack}\n`)
  process.exitCode = 1
})
