const assert = require('node:assert/strict')
const addon = require(process.argv[2])
const failure = process.env.ORCA_PTY_TEST_FAILURE
let result
let error
let onexit
const exited = new Promise((resolve) => {
  onexit = resolve
})
try {
  result = addon.fork(
    '/bin/sh',
    ['-c', 'exit 0'],
    [],
    process.cwd(),
    80,
    24,
    -1,
    -1,
    false,
    '',
    onexit
  )
} catch (err) {
  error = err
}
if (failure) {
  const state = addon.testSpawnState()
  assert.match(error?.message || '', /Could not set master fd/)
  assert.equal(state.masterClosed, true, 'failed spawn must close its master')
  const cleanupFailure = process.env.ORCA_PTY_TEST_CLEANUP_FAILURE
  if (cleanupFailure && cleanupFailure !== 'KILL_ESRCH') {
    assert.match(error.message, new RegExp(`PTY child ${state.pid} cleanup failed:`))
    const reason =
      cleanupFailure === 'KILL_EPERM' ? 'Operation not permitted' : 'Input/output error'
    assert.ok(
      error.message.endsWith(reason),
      'spawn error must preserve the cleanup failure reason'
    )
    assert.equal(state.kills, cleanupFailure === 'WAIT_INITIAL' ? 0 : 1)
    assert.equal(state.blockingWaits, cleanupFailure === 'WAIT_FINAL' ? 1 : 0)
    if (cleanupFailure !== 'WAIT_FINAL') {
      assert.equal(state.childReaped, false, 'denied cleanup must not claim the child was reaped')
    }
  } else {
    assert.doesNotMatch(error.message, /cleanup failed/)
    assert.equal(state.childReaped, true, 'failed spawn must terminate and reap its child')
    assert.equal(state.kills, process.env.ORCA_PTY_TEST_REAPED ? 0 : 1)
  }
  if (process.env.ORCA_PTY_TEST_EINTR) {
    assert.ok(state.waitInterrupts >= 2)
    assert.ok(state.blockingInterrupts >= 2)
  }
  console.log('clean failure')
} else {
  assert.ifError(error)
  exited
    .then(() => {
      assert.ifError(error)
      assert.ok(result.pid > 0)
      // SetupExitCallback has already reaped the child before invoking onexit.
      const state = addon.testSpawnState()
      assert.equal(state.masterClosed, false)
      assert.equal(state.cloexec, true)
      assert.equal(state.childReaped, true)
      require('node:fs').closeSync(result.fd)
      console.log('normal spawn')
    })
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
}
