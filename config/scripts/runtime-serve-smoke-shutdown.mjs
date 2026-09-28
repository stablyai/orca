import { createServeStopRequest } from '../../src/shared/serve-supervisor-control.ts'
import { existsSync } from 'node:fs'
import { runtimeServeSmokeProcessState } from './runtime-serve-smoke-launch.mjs'
import {
  QUIT_RENDERER_ACK_TIMEOUT_MS,
  WILL_QUIT_TEARDOWN_DEADLINE_MS
} from '../../src/shared/quit-teardown-deadline.ts'

export const SHUTDOWN_TIMEOUT_MS =
  QUIT_RENDERER_ACK_TIMEOUT_MS + WILL_QUIT_TEARDOWN_DEADLINE_MS + 10_000

const gracefulStops = new WeakMap()

export function prepareServerShutdown(child) {
  const stop = createServeStopRequest(child)
  child.on('message', stop.handleMessage)
  child.once('exit', () => child.off('message', stop.handleMessage))
  gracefulStops.set(child, stop)
}

export async function stopServer(
  child,
  lockPath,
  launcherOwnerLoss = false,
  servingPid = null,
  inspectProcess = runtimeServeSmokeProcessState
) {
  const ownerLoss = process.platform === 'win32' && launcherOwnerLoss
  const launcherExited = () => child.exitCode !== null || child.signalCode !== null
  const validExit = (code, signal) => code === 0 || (ownerLoss && signal === 'SIGTERM')
  const serverExited = () => servingPid === null || inspectProcess(servingPid) === 'exited'
  if (launcherExited() && !validExit(child.exitCode, child.signalCode)) {
    throw new Error(`server exited unexpectedly: ${child.exitCode ?? child.signalCode}`)
  }
  if (!launcherExited() || !serverExited()) {
    await new Promise((resolvePromise, rejectPromise) => {
      let poll
      const finish = (error) => {
        clearTimeout(timer)
        clearInterval(poll)
        child.off('exit', onExit)
        child.off('close', onExit)
        if (error) {
          rejectPromise(error)
        } else {
          resolvePromise()
        }
      }
      const timer = setTimeout(() => {
        if (!launcherExited()) {
          child.kill('SIGKILL')
        }
        finish(new Error(`server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`))
      }, SHUTDOWN_TIMEOUT_MS)
      const onExit = (code, signal) => {
        if (!validExit(code, signal)) {
          finish(new Error(`server shutdown failed: ${code ?? signal}`))
        } else if (serverExited()) {
          finish()
        }
      }
      child.once('exit', onExit)
      child.once('close', onExit)
      // Persistent helpers may retain pipes after both launcher and server have exited.
      poll = setInterval(() => {
        if (launcherExited()) {
          onExit(child.exitCode, child.signalCode)
        }
      }, 50)
      if (!launcherExited()) {
        const graceful = gracefulStops.get(child)
        if (graceful) {
          graceful.request()
        } else {
          child.kill('SIGTERM')
        }
      }
    })
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  if (lockPath && existsSync(lockPath)) {
    throw new Error('Server exited without releasing its profile lock')
  }
}
