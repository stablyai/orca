'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeSync } = require('node:fs')
const { dirname, resolve } = require('node:path')

function report(phase, details = {}) {
  writeSync(1, `${JSON.stringify({ phase, hostPid: process.pid, ...details })}\n`)
}

async function exerciseTable() {
  assert.equal(process.platform, 'win32', 'This probe requires real Windows ConPTY')
  const rounds = Number(process.env.ORCA_PTY_TABLE_STRESS_ROUNDS ?? 8)
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 2000)
  const pty = require('node-pty')
  const nativePath = require.resolve('node-pty/lib/utils')
  const loaded = require(nativePath).loadNativeModule('conpty')
  const native = loaded.module
  const addonPath = resolve(dirname(nativePath), loaded.dir, 'conpty.node')
  report('native', {
    addonPath,
    sha256: createHash('sha256').update(readFileSync(addonPath)).digest('hex'),
    node: process.version,
    rounds
  })
  assert.equal(native.assignCurrentProcessToJob(), true, 'Crash cleanup needs a host job')

  const spawned = []
  function spawn(round, slot) {
    report('spawn', { round, slot })
    const proc = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      useConptyDll: true
    })
    const record = { proc, output: '', exited: false, closed: false }
    const marker = `ORCA_PTY_READY_${spawned.length}`
    let resolveReady
    record.ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    record.exit = new Promise((resolveExit) => {
      proc.onExit((event) => {
        record.exited = true
        resolveReady(false)
        resolveExit(event)
      })
    })
    proc.onData((chunk) => {
      record.output = (record.output + chunk).slice(-2048)
      if (record.output.includes(marker)) {
        resolveReady(true)
      }
    })
    spawned.push(record)
    // Escaping one letter keeps echoed input from satisfying the output marker.
    proc.write(`echo ${marker.replace('READY', 'REA^DY')}\r`)
    return record
  }

  async function waitForReady(records) {
    let timer
    try {
      await Promise.race([
        Promise.all(
          records.map(async (record) => {
            assert.equal(await record.ready, true, `Shell exited before ready: ${record.output}`)
          })
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const transcripts = records.map(({ proc, output }) => ({ pid: proc.pid, output }))
            reject(new Error(`PTY readiness timed out: ${JSON.stringify(transcripts)}`))
          }, 15_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    report('ready', { shellPids: records.map(({ proc }) => proc.pid) })
  }

  function close(record, round, slot) {
    report('kill', { round, slot, shellPid: record.proc.pid })
    record.proc.kill()
    record.closed = true
  }

  try {
    const survivor = spawn(-1, -1)
    await waitForReady([survivor])
    const slots = []
    for (let round = 0; round < rounds; round += 1) {
      for (let slot = 0; slot < 3; slot += 1) {
        if (slots[slot]) {
          close(slots[slot], round, slot)
        }
        // The next lookup/insertion overlaps the previous shell's native exit watcher.
        slots[slot] = spawn(round, slot)
        report('resize-clear-list', { round, slot, shellPid: survivor.proc.pid })
        survivor.proc.resize(80 + (round % 2), 24)
        survivor.proc.clear()
        const members = native.listJobProcessIds(survivor.proc._pty, survivor.proc.pid)
        assert.ok(members?.includes(survivor.proc.pid), 'A live survivor must retain its job')
      }
      // A ready terminal runs kill/resize/clear immediately instead of deferring them.
      await waitForReady(slots)
    }
    assert.equal(survivor.exited, false, survivor.output)
    report('overlap-complete', { terminals: spawned.length })
  } finally {
    for (const record of spawned) {
      if (!record.closed) {
        close(record, -1, -1)
      }
    }
    let timer
    try {
      await Promise.race([
        Promise.all(spawned.map((record) => record.exit)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('PTY exit callbacks did not drain')), 15_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  report('complete', { terminals: spawned.length })
}

exerciseTable().catch((error) => {
  report('error', { message: error.stack })
  process.exitCode = 1
})
