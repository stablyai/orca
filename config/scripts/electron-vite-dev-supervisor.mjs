import { spawn } from 'node:child_process'
import { inspectLinuxDevGpuOutput } from './linux-dev-gpu-retry.mjs'

const GPU_RESTART_DELAY_MS = 250
const ATTEMPT_OUTPUT_SETTLE_MS = 50
const CHILD_TERMINATION_TIMEOUT_MS = 5000

export function runElectronViteDevSupervisor({ nodePath, electronViteCli, args, env }) {
  let activeAttempt = null
  let gpuFallbackRetryStarted = false
  let gpuLaunchFailures = 0
  let isShuttingDown = false
  let restartTimer = null
  let shutdownSignal = null

  function exitSupervisor(exitCode) {
    process.exitCode = exitCode
    process.exit(exitCode)
  }

  function signalExitCode(signal) {
    if (signal === 'SIGINT') {
      return 130
    }
    if (signal === 'SIGTERM') {
      return 143
    }
    return 1
  }

  function signalAttempt(attempt, signal) {
    if (!attempt.child.pid) {
      return
    }
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill', ['/pid', String(attempt.child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      taskkill.unref()
      return
    }
    try {
      process.kill(-attempt.child.pid, signal)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== 'ESRCH') {
        throw error
      }
    }
  }

  function clearAttemptTimers(attempt) {
    if (attempt.decisionTimer) {
      clearTimeout(attempt.decisionTimer)
      attempt.decisionTimer = null
    }
    if (attempt.forcedKillTimer) {
      clearTimeout(attempt.forcedKillTimer)
      attempt.forcedKillTimer = null
    }
  }

  function terminateAttempt(attempt, signal) {
    if (attempt.terminationStarted) {
      return
    }
    attempt.terminationStarted = true
    signalAttempt(attempt, signal)
    attempt.forcedKillTimer = setTimeout(() => {
      signalAttempt(attempt, 'SIGKILL')
    }, CHILD_TERMINATION_TIMEOUT_MS)
  }

  function finishAttempt(attempt) {
    if (attempt !== activeAttempt) {
      return
    }
    clearAttemptTimers(attempt)

    if (isShuttingDown) {
      signalAttempt(attempt, 'SIGKILL')
      activeAttempt = null
      exitSupervisor(signalExitCode(shutdownSignal ?? attempt.signal ?? 'SIGINT'))
      return
    }

    if (attempt.gpuFallbackRetryRequested && !gpuFallbackRetryStarted) {
      gpuFallbackRetryStarted = true
      signalAttempt(attempt, 'SIGKILL')
      activeAttempt = null
      env.ORCA_DEV_GPU_FALLBACK = '1'
      restartTimer = setTimeout(() => {
        restartTimer = null
        spawnDevChild()
      }, GPU_RESTART_DELAY_MS)
      return
    }

    activeAttempt = null
    if (attempt.spawnError) {
      console.error(attempt.spawnError)
      exitSupervisor(1)
      return
    }
    exitSupervisor(attempt.signal ? signalExitCode(attempt.signal) : (attempt.exitCode ?? 1))
  }

  function scheduleAttemptFinish(attempt) {
    if (attempt !== activeAttempt || (!attempt.exited && !attempt.spawnError)) {
      return
    }
    if (attempt.decisionTimer) {
      clearTimeout(attempt.decisionTimer)
    }
    attempt.decisionTimer = setTimeout(() => finishAttempt(attempt), ATTEMPT_OUTPUT_SETTLE_MS)
  }

  function requestGpuFallback(attempt) {
    if (attempt !== activeAttempt || gpuFallbackRetryStarted || attempt.gpuFallbackRetryRequested) {
      return
    }
    attempt.gpuFallbackRetryRequested = true
    console.error(
      '[gpu-fallback] GPU startup is failing; restarting this dev run once with software rendering.'
    )
    terminateAttempt(attempt, 'SIGTERM')
  }

  function spawnDevChild() {
    if (isShuttingDown) {
      return
    }
    const nextChild = spawn(nodePath, [electronViteCli, ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32'
    })
    const attempt = {
      child: nextChild,
      decisionTimer: null,
      exited: false,
      exitCode: null,
      forcedKillTimer: null,
      gpuFallbackRetryRequested: false,
      signal: null,
      spawnError: null,
      terminationStarted: false
    }
    activeAttempt = attempt

    nextChild.stdout.pipe(process.stdout)
    nextChild.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      if (process.platform !== 'linux' || gpuFallbackRetryStarted) {
        return
      }
      const inspection = inspectLinuxDevGpuOutput(chunk.toString(), gpuLaunchFailures)
      gpuLaunchFailures = inspection.failures
      if (inspection.retry) {
        requestGpuFallback(attempt)
      }
    })
    nextChild.on('error', (error) => {
      attempt.spawnError = error
      scheduleAttemptFinish(attempt)
    })
    nextChild.on('exit', (code, signal) => {
      attempt.exited = true
      attempt.exitCode = code
      attempt.signal = signal
      scheduleAttemptFinish(attempt)
    })
  }

  function beginShutdown(signal) {
    if (isShuttingDown) {
      return
    }
    isShuttingDown = true
    shutdownSignal = signal
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (!activeAttempt) {
      exitSupervisor(signalExitCode(signal))
      return
    }
    terminateAttempt(activeAttempt, signal)
  }

  process.on('SIGINT', () => beginShutdown('SIGINT'))
  process.on('SIGTERM', () => beginShutdown('SIGTERM'))
  spawnDevChild()
}
