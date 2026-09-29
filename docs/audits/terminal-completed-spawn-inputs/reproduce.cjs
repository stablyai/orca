const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { load, evaluatedSourceHashes, sourceMode, reportPrefix } = require('./spawn-source.cjs')
const {
  subprocess,
  streamClient,
  startWithInputs,
  counts,
  expected,
  collect
} = require('./spawn-fixture.cjs')
const fixed = !process.argv.includes('--baseline')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(typeof global.gc, 'function')

async function completedInputs(Host) {
  const host = new Host({ spawnSubprocess: async () => subprocess() })
  const refs = []
  try {
    for (let index = 0; index < 3; index += 1) {
      const created = startWithInputs(host, `retention-${index}`)
      assert.equal((await created.creation).historySeeded, true)
      refs.push(created.refs)
    }
    await collect()
    const whileLive = counts(refs)
    assert.deepEqual(whileLive, expected(fixed ? 0 : 3))
    assert.equal(host.listSessions().length, 3)
    assert.ok(host.getSnapshot('retention-0').snapshotAnsi.includes('retention-seed'))
    await host.dispose()
    await collect()
    const afterDispose = counts(refs)
    assert.deepEqual(afterDispose, expected(0))
    return { case: 'completed-inputs', whileLive, afterDispose, liveSessionCountAtCollection: 3 }
  } finally {
    await host.dispose()
  }
}

async function pendingInputs(Host) {
  const gate = Promise.withResolvers()
  const host = new Host({
    spawnSubprocess: async () => {
      await gate.promise
      return subprocess()
    }
  })
  const created = startWithInputs(host, 'pending')
  try {
    await collect()
    const duringSpawn = counts([created.refs])
    assert.deepEqual(duringSpawn, expected(1))
    gate.resolve()
    assert.equal((await created.creation).isNew, true)
    await collect()
    const afterPublication = counts([created.refs])
    assert.deepEqual(afterPublication, expected(fixed ? 0 : 1))
    await host.dispose()
    await collect()
    assert.deepEqual(counts([created.refs]), expected(0))
    return {
      case: 'pending-inputs',
      duringSpawn,
      afterPublication,
      afterDispose: counts([created.refs])
    }
  } finally {
    gate.resolve()
    await created.creation
    await host.dispose()
  }
}

async function exitAndRecreate(Host) {
  const handles = []
  const reaped = []
  const host = new Host({
    spawnSubprocess: async () => {
      const handle = subprocess()
      handles.push(handle)
      return handle
    },
    onSessionReaped: (id) => reaped.push(id)
  })
  const options = {
    sessionId: 'claimed',
    cols: 80,
    rows: 24,
    streamClient,
    agentSessionEnsure: {
      claim: {
        digestVersion: 1,
        keyId: 'key',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        agent: 'codex'
      },
      surface: {
        worktreeId: 'worktree',
        tabId: 'tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_claimed'
      }
    }
  }
  try {
    const first = await host.createOrAttach(options)
    handles[0].emitExit(7)
    assert.deepEqual(reaped, ['claimed'])
    assert.deepEqual(host.listSessions(), [])
    const evidence = (
      await host.inspectProcess('claimed', { expectedIncarnationId: first.incarnationId })
    ).foregroundProcessEvidence
    assert.equal(evidence.verdict, 'exited')
    assert.equal(evidence.reason, 'pty_exit_7')
    assert.equal(evidence.ptyIncarnationId, first.incarnationId)
    const second = await host.createOrAttach(options)
    assert.equal(second.agentSessionEnsure.disposition, 'created')
    assert.notEqual(
      second.agentSessionEnsure.owner.generation,
      first.agentSessionEnsure.owner.generation
    )
    assert.notEqual(second.incarnationId, first.incarnationId)
    assert.equal(handles.length, 2)
    await host.dispose()
    assert.deepEqual(reaped, ['claimed', 'claimed'])
    return {
      case: 'exit-and-recreate',
      exitVerdict: evidence.verdict,
      exitReason: evidence.reason,
      reaped,
      newIncarnation: true,
      newGeneration: true
    }
  } finally {
    await host.dispose()
  }
}

async function foregroundConfirmation(Host) {
  const gate = Promise.withResolvers()
  let confirmations = 0
  const handle = {
    ...subprocess(),
    confirmShellForeground() {
      assert.equal(this, handle)
      confirmations += 1
      return gate.promise
    }
  }
  const host = new Host({ spawnSubprocess: async () => handle })
  try {
    await host.createOrAttach({ sessionId: 'recovery', cols: 80, rows: 24, streamClient })
    handle.emitData('\x1b[?1049hTUI\x1b]133;D;137\x07SHELL-PROMPT')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(confirmations, 1)
    gate.resolve(true)
    const snapshot = await host.getSettledSnapshot('recovery')
    assert.equal(snapshot.terminalOwner, 'shell')
    assert.ok(snapshot.snapshotAnsi.includes('SHELL-PROMPT'))
    return {
      case: 'foreground-confirmation',
      confirmations,
      preservedReceiver: true,
      owner: snapshot.terminalOwner,
      queuedPromptReleased: true
    }
  } finally {
    gate.resolve(false)
    await host.dispose()
  }
}

async function main() {
  const Host = await load(fixed)
  const reports = [
    await completedInputs(Host),
    await pendingInputs(Host),
    await exitAndRecreate(Host),
    await foregroundConfirmation(Host)
  ]
  const report = {
    node: process.version,
    electron: process.versions.electron ?? null,
    v8: process.versions.v8,
    fixed,
    sourceMode,
    sourceHashes: Object.fromEntries(
      Object.entries(evaluatedSourceHashes).map(([file, hashes]) => [
        file,
        fixed ? hashes.fixed : hashes.baseline
      ])
    ),
    reports
  }
  const file = `${reportPrefix}${process.versions.electron ? 'electron' : 'node'}-${fixed ? 'fixed' : 'baseline'}.json`
  fs.writeFileSync(path.join(__dirname, file), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
setTimeout(() => {
  console.error('fixture timeout')
  process.exit(2)
}, 15000).unref()
