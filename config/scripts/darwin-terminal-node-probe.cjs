const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const dns = require('node:dns/promises')
const pty = require(process.argv[3])
const canary = require(process.argv[2])

const deadline = setTimeout(() => process.exit(2), 45_000)
async function checkIo() {
  await Promise.all([
    fs.stat(process.execPath),
    dns.lookup('localhost'),
    new Promise((resolve, reject) => {
      crypto.randomBytes(32, (error) => (error ? reject(error) : resolve()))
    })
  ])
}

async function checkPty() {
  const terminal = pty.spawn('/bin/sh', ['-c', 'read line; printf "ECHO:%s\\n" "$line"'], {
    cwd: process.argv[4],
    env: process.env
  })
  let output = ''
  terminal.onData((chunk) => {
    output += chunk
  })
  const exited = new Promise((resolve, reject) => {
    terminal.onExit(({ exitCode }) =>
      exitCode === 0 ? resolve() : reject(new Error('PTY failed'))
    )
  })
  terminal.write('ORCA_WORKER_WAKEUP_TEST\r')
  await exited
  assert.ok(output.includes('ECHO:ORCA_WORKER_WAKEUP_TEST'))
}

async function main() {
  assert.equal(process.version, process.argv[5])
  await checkIo()
  await checkPty()
  canary.enroll()
  let before
  for (let i = 0; i < 100; i++) {
    await delay(10)
    before = JSON.parse(canary.snapshot())
    if (before.callbacks === 4 && before.waits.every((wait) => wait.parked)) {
      break
    }
  }
  assert.equal(before.callbacks, 4)
  assert.ok(before.waits.every((wait) => wait.parked))
  await delay(31_000)
  const after = JSON.parse(canary.snapshot())
  assert.ok(after.waits.every((wait) => wait.parked))
  for (let i = 0; i < 4; i++) {
    const previous = BigInt(`0x${before.waits[i].generation}`)
    const current = BigInt(`0x${after.waits[i].generation}`)
    const advances = BigInt.asUintN(32, current - previous)
    assert.ok(advances > 0n)
    assert.ok(advances <= 16n * 256n)
  }
  await checkIo()
  clearTimeout(deadline)
  console.log(
    JSON.stringify({
      node: process.version,
      uv: process.versions.uv,
      arch: process.arch,
      fsDnsCrypto: 'passed',
      ptyInput: 'passed',
      idleWaitRefresh: 'passed'
    })
  )
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
