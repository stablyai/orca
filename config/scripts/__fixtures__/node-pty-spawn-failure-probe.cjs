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
  assert.equal(state.childReaped, true, 'failed spawn must terminate and reap its child')
  assert.equal(state.kills, process.env.ORCA_PTY_TEST_REAPED ? 0 : 1)
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
