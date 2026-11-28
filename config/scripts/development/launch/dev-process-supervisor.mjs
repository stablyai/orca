import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { drainDevProcessGroup } from './drain-dev-process-group.mjs'

let shuttingDown = false
let deadline = null
let shutdownDeadline = null

function stop(signal = 'SIGTERM') {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  shutdownDeadline = performance.now() + 5000
  signalChild(signal === 'SIGHUP' ? 'SIGTERM' : signal)
  deadline = setTimeout(() => signalChild('SIGKILL'), 5000)
}

function signalChild(signal) {
  if (!child.pid) {
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }
  }
}

process.once('disconnect', () => stop())
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal))
}
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', detached: true })
child.once('error', (error) => {
  console.error(error)
  process.exit(1)
})
child.once('exit', async (code, signal) => {
  clearTimeout(deadline)
  // Keep cleanup outside both the launching command group and Vite's group.
  const graceMs =
    shutdownDeadline === null ? 5000 : Math.max(0, shutdownDeadline - performance.now())
  await drainDevProcessGroup(child.pid, graceMs)
  process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1))
})
