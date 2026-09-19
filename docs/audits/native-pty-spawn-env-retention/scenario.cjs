const assert = require('node:assert/strict')
const { EventEmitter2 } = require('node-pty/lib/eventEmitter2')

function nativePort() {
  const data = new EventEmitter2()
  const exit = new EventEmitter2()
  const calls = { writes: 0, resizes: 0, pauses: 0, resumes: 0, kills: 0, destroys: 0 }
  return {
    process: {
      pid: 0,
      process: 'audit-shell',
      onData: data.event,
      onExit: exit.event,
      write() {
        calls.writes++
      },
      resize() {
        calls.resizes++
      },
      pause() {
        calls.pauses++
      },
      resume() {
        calls.resumes++
      },
      clear() {},
      kill() {
        calls.kills++
      },
      destroy() {
        calls.destroys++
      }
    },
    emitData: (value) => data.fire(value),
    emitExit: (value) => exit.fire(value),
    calls
  }
}

function start(create, reportsChildExitStatus) {
  const native = nativePort()
  const env = { PATH: '/synthetic/audit/bin', RETENTION_FIXTURE: 'small ordinary field' }
  const args = {
    process: native.process,
    shellPath: '/synthetic/audit-shell',
    spawnCwd: '/synthetic',
    requestedCwd: '/synthetic',
    sessionId: 'native-env-audit',
    startupAgentRecognition: null,
    env,
    startupCommandDeliveredInShellArgs: true,
    reportsChildExitStatus
  }
  return {
    handle: create(args),
    native,
    refs: { args: new WeakRef(args), env: new WeakRef(env) }
  }
}

async function collect() {
  for (let round = 0; round < 6; round++) {
    await new Promise(setImmediate)
    global.gc()
  }
}
function counts(refs) {
  return Object.fromEntries(
    ['args', 'env'].map((key) => [key, refs.filter((ref) => ref[key].deref()).length])
  )
}

async function run(create, fixed) {
  const originalKill = process.kill
  const nativeSignals = []
  process.kill = (...args) => {
    nativeSignals.push(args)
    throw new Error('No OS signal permitted in proof')
  }
  try {
    let owner = start(create, true)
    const refs = [owner.refs]
    await collect()
    const whileLive = counts(refs)
    assert.deepEqual(whileLive, { args: fixed ? 0 : 1, env: fixed ? 0 : 1 })
    assert.equal(owner.handle.shellPathEnv, '/synthetic/audit/bin')
    assert.equal(owner.handle.startupCommandDeliveredInShellArgs, true)
    assert.equal(owner.handle.getForegroundProcess({ rawFallback: true }), 'audit-shell')
    const output = []
    const exits = []
    owner.native.emitData('early-output')
    owner.handle.onData((data) => output.push(data))
    owner.handle.onExit((code, cause) => exits.push({ code, cause }))
    owner.handle.write('a')
    owner.handle.resize(80, 24)
    owner.handle.pause()
    owner.handle.resume()
    owner.native.emitExit({ exitCode: 7, signal: 0 })
    assert.deepEqual(exits, [{ code: 7, cause: { kind: 'exited', exitCode: 7 } }])
    assert.deepEqual(output, ['early-output'])
    owner.handle.write('after-exit')
    owner.handle.kill()
    owner.handle.forceKill()
    owner.handle.signal('SIGKILL')
    assert.equal(owner.native.calls.writes, 1)
    assert.equal(owner.native.calls.kills, 0)
    owner.handle.dispose()
    owner.handle.dispose()
    assert.equal(owner.native.calls.destroys, 1)
    owner = null
    await collect()
    const afterOwnerDrop = counts(refs)
    assert.deepEqual(afterOwnerDrop, { args: 0, env: 0 })

    const unavailable = start(create, false)
    const unavailableExits = []
    unavailable.native.emitExit({ exitCode: 0, signal: 9 })
    unavailable.handle.onExit((code, cause) => unavailableExits.push({ code, cause }))
    assert.deepEqual(unavailableExits, [
      { code: 0, cause: { kind: 'unknown', reason: 'host_status_unavailable' } }
    ])
    unavailable.handle.dispose()
    const signaled = start(create, true)
    const signaledExits = []
    signaled.handle.onExit((code, cause) => signaledExits.push({ code, cause }))
    signaled.native.emitExit({ exitCode: 0, signal: 9 })
    assert.deepEqual(signaledExits, [{ code: 0, cause: { kind: 'signaled', signal: 9 } }])
    signaled.handle.dispose()
    assert.deepEqual(nativeSignals, [])
    return {
      whileLive,
      afterOwnerDrop,
      controls: [
        'PATH retained',
        'raw foreground receiver',
        'pre-listener data/exit',
        'status unavailable',
        'signal cause',
        'dead signal guard',
        'idempotent dispose'
      ]
    }
  } finally {
    process.kill = originalKill
  }
}

module.exports = run
