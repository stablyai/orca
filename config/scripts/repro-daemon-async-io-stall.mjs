import assert from 'node:assert/strict'
import { constants, closeSync, mkdtempSync, open, openSync, rmSync, stat, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { spawn } from 'node-pty'

// Fault injection validates the failure boundary; the incident's workers were idle, not saturated.
if (process.platform === 'win32' || process.env.UV_THREADPOOL_SIZE !== '1') {
  throw new Error(
    'Run on macOS/Linux with ORCA_BACKGROUND_LAUNCH=1 UV_THREADPOOL_SIZE=1 node config/scripts/repro-daemon-async-io-stall.mjs'
  )
}

const dir = mkdtempSync(join(tmpdir(), 'orca-async-io-repro-'))
const fifo = join(dir, 'blocked-open')
let terminal
let healthTerminal
let blockedOpen
let released = false
function releaseWorker() {
  if (blockedOpen && !released) {
    released = true
    closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK))
  }
}
const watchdog = setTimeout(() => {
  releaseWorker()
  terminal?.kill()
  healthTerminal?.kill()
  console.error('Reproduction exceeded its deadline')
  process.exit(1)
}, 15_000)

try {
  const probeModule = join(dir, 'probe.mjs')
  await build({
    entryPoints: [resolve('src/main/daemon/daemon-async-io-probe.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: probeModule
  })
  const { DaemonAsyncIoProbe } = await import(pathToFileURL(probeModule).href)
  const result = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 3000 })
  assert.equal(result.code, 0)

  terminal = spawn('/bin/cat', [], { cwd: dir, cols: 80, rows: 24, env: process.env })
  let output = ''
  terminal.onData((chunk) => {
    output += chunk
  })
  terminal.write('BEFORE_STALL\r')
  for (let attempt = 0; !output.includes('BEFORE_STALL') && attempt < 100; attempt++) {
    await delay(10)
  }
  assert.ok(output.includes('BEFORE_STALL'), 'PTY input must work before fault injection')

  blockedOpen = new Promise((resolveOpen, rejectOpen) => {
    open(fifo, 'r', (error, fd) => {
      if (error) {
        rejectOpen(error)
      } else {
        closeSync(fd)
        resolveOpen()
      }
    })
  })
  const probe = new DaemonAsyncIoProbe()
  const pending = probe.check()
  let cwdCheckCompleted = false
  stat(dir, () => {
    cwdCheckCompleted = true
  })
  terminal.write('QUEUED_INPUT\r')

  // Native spawn/exit and PTY output do not require the blocked filesystem worker.
  healthTerminal = spawn('/bin/sh', ['-c', 'exit 0'], { cwd: dir, env: process.env })
  const nativeHealth = new Promise((resolveExit) => {
    healthTerminal.onExit(({ exitCode }) => resolveExit(exitCode))
  })
  assert.equal(await nativeHealth, 0)
  const health = await pending
  assert.equal(health.state, 'stalled')
  assert.equal(cwdCheckCompleted, false)
  assert.equal(output.includes('QUEUED_INPUT'), false)
  writeSync(terminal._fd, 'SYNCHRONOUS_INPUT\r')
  for (let attempt = 0; !output.includes('SYNCHRONOUS_INPUT') && attempt < 100; attempt++) {
    await delay(10)
  }
  assert.ok(output.includes('SYNCHRONOUS_INPUT'), 'The real PTY still accepts synchronous input')
  console.log(
    JSON.stringify({
      nativeSpawnHealthy: true,
      asyncCwdBlocked: true,
      asyncInputBlocked: true,
      syncInputDelivered: true,
      detector: health
    })
  )

  releaseWorker()
  await blockedOpen
  for (
    let attempt = 0;
    (!cwdCheckCompleted || !output.includes('QUEUED_INPUT')) && attempt < 100;
    attempt++
  ) {
    await delay(10)
  }
  assert.ok(cwdCheckCompleted)
  assert.ok(output.includes('QUEUED_INPUT'))
  assert.equal((await probe.check()).state, 'healthy')
  console.log(JSON.stringify({ recovery: 'healthy', queuedInputDelivered: true }))
} finally {
  releaseWorker()
  await blockedOpen
  terminal?.kill()
  healthTerminal?.kill()
  clearTimeout(watchdog)
  rmSync(dir, { recursive: true, force: true })
}
