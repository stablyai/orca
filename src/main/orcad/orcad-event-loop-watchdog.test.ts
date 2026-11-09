import { spawn } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import {
  ORCAD_EVENT_LOOP_WATCHDOG_ENV,
  ORCAD_EVENT_LOOP_WATCHDOG_WORKER_SOURCE,
  startOrcadEventLoopWatchdog,
  type OrcadEventLoopWatchdog,
  type OrcadEventLoopWatchdogMessage
} from './orcad-event-loop-watchdog'

const watchdogs: OrcadEventLoopWatchdog[] = []
afterEach(() => watchdogs.splice(0).forEach((watchdog) => watchdog.stop()))

/** Models a synchronous call that never yields the event loop; the worker's clock cannot be faked. */
function blockMainThread(ms: number): void {
  // ast-grep-ignore: test-no-wall-clock -- a busy-wait must read the real clock to block the real thread
  const until = Date.now() + ms
  // ast-grep-ignore: test-no-wall-clock -- a busy-wait must read the real clock to block the real thread
  while (Date.now() < until) {
    // Busy-wait.
  }
}

it('reports a blocked event loop from a thread the block cannot starve, then its recovery (#34410)', async () => {
  const watchdog = startOrcadEventLoopWatchdog({
    supervised: false,
    env: {},
    timings: { beatIntervalMs: 20, checkIntervalMs: 50, warnAfterMs: 300 }
  })
  expect(watchdog).not.toBeNull()
  watchdogs.push(watchdog!)
  const messages: OrcadEventLoopWatchdogMessage[] = []
  watchdog!.worker.on('message', (message: OrcadEventLoopWatchdogMessage) => messages.push(message))
  await expect.poll(() => messages.map((message) => message.type)).toEqual(['started'])

  blockMainThread(900)

  await expect
    .poll(() => messages.map((message) => message.type), { timeout: 2000 })
    .toEqual(['started', 'stalled', 'recovered'])
  const stalled = messages[1]
  expect(stalled.type === 'stalled' && stalled.blockedMs >= 300).toBe(true)
})

it('can be turned off', () => {
  expect(
    startOrcadEventLoopWatchdog({ supervised: true, env: { [ORCAD_EVENT_LOOP_WATCHDOG_ENV]: '0' } })
  ).toBeNull()
})

// Why the longer timeout: the child must boot a runtime and a worker before its loop blocks.
it('ends a supervised process whose event loop stays blocked past the exit bound', async () => {
  // A child process stands in for orcad so the test runner survives the kill.
  const script = `
    const { Worker } = require('node:worker_threads')
    const worker = new Worker(process.env.WATCHDOG_SOURCE, {
      eval: true,
      workerData: {
        beat: new SharedArrayBuffer(4),
        checkIntervalMs: 50,
        warnAfterMs: 100,
        exitAfterMs: 300
      }
    })
    worker.once('message', () => {
      const until = Date.now() + 10000
      while (Date.now() < until) {}
      process.exit(0)
    })
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, WATCHDOG_SOURCE: ORCAD_EVENT_LOOP_WATCHDOG_WORKER_SOURCE },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  expect(exit.code === 0 && exit.signal === null).toBe(false)
  expect(stderr).toContain('exiting so the service manager restarts it')
}, 20_000)
