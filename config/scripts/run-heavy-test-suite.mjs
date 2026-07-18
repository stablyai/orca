import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { cleanupE2ERunScope, prepareE2ERunScope } from '../../tests/e2e/e2e-run-scope-runtime.mts'
import {
  HeavySuiteBusyError,
  acquireHeavySuiteLock,
  releaseHeavySuiteLock,
  updateHeavySuiteState
} from './heavy-test-suite-lock.mjs'

export {
  HEAVY_SUITE_LOCK_BASENAME,
  HeavySuiteBusyError,
  acquireHeavySuiteLock,
  getHeavySuiteLockPath,
  getHeavySuiteRecoveryGuardPath,
  isProcessAlive,
  isProcessTreeAlive,
  releaseHeavySuiteLock,
  updateHeavySuiteState
} from './heavy-test-suite-lock.mjs'

const FORCE_KILL_AFTER_MS = 5_000
const modulePath = import.meta.filename
const repoRoot = path.resolve(import.meta.dirname, '../..')

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0
}

export function terminateChildTree(
  childPid,
  signal,
  {
    platform = process.platform,
    killProcess = process.kill,
    spawnProcess = spawn,
    onError = (error) => console.error(error)
  } = {}
) {
  if (!isValidPid(childPid)) {
    return
  }
  if (platform === 'win32') {
    let taskkill
    try {
      taskkill = spawnProcess('taskkill', ['/pid', String(childPid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (error) {
      onError(error)
      return
    }
    taskkill.once('error', onError)
    taskkill.unref()
    return
  }
  try {
    killProcess(-childPid, signal)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'ESRCH') {
      onError(error)
    }
  }
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') {
    return 130
  }
  if (signal === 'SIGTERM') {
    return 143
  }
  if (signal === 'SIGHUP') {
    return 129
  }
  return 1
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false
    let childError = null
    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }
    // `close` follows both spawn errors and normal exits after stdio handles
    // close. Waiting for it prevents releasing admission while a child that
    // emitted `error` still has a live process tree.
    child.once('error', (error) => {
      childError = error
    })
    child.once('close', (code, signal) => finish({ error: childError, code, signal }))
  })
}

export async function runHeavyTestSuite({
  suite,
  steps,
  tempDir = os.tmpdir(),
  platform = process.platform,
  spawnProcess = spawn,
  killProcess = process.kill,
  updateChildState = updateHeavySuiteState,
  terminateChild = terminateChildTree,
  signalSource = process,
  prepareRun = () => {},
  cleanupRun = () => {},
  forceKillAfterMs = FORCE_KILL_AFTER_MS
}) {
  let handle
  try {
    handle = acquireHeavySuiteLock({ suite, tempDir })
  } catch (error) {
    if (error instanceof HeavySuiteBusyError) {
      console.error(error.message)
      return 1
    }
    throw error
  }

  let currentChild = null
  let shutdownSignal = null
  let forcedKillTimer = null
  const terminationErrors = []
  const recordTerminationError = (error) => {
    terminationErrors.push(error)
    console.error(error)
  }
  const stopCurrentChild = (signal) => {
    if (currentChild?.pid) {
      terminateChild(currentChild.pid, signal, {
        platform,
        killProcess,
        spawnProcess,
        onError: recordTerminationError
      })
    }
  }
  const scheduleForcedKill = () => {
    if (forcedKillTimer) {
      return
    }
    forcedKillTimer = setTimeout(() => stopCurrentChild('SIGKILL'), forceKillAfterMs)
    forcedKillTimer.unref()
  }
  const beginShutdown = (signal) => {
    if (shutdownSignal) {
      return
    }
    shutdownSignal = signal
    stopCurrentChild(signal)
    if (currentChild?.pid) {
      scheduleForcedKill()
    }
  }
  const signalHandlers = new Map(
    ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => beginShutdown(signal)])
  )
  for (const [signal, handler] of signalHandlers) {
    signalSource.on(signal, handler)
  }

  const executeSteps = async () => {
    try {
      await prepareRun()
    } catch (error) {
      console.error(error)
      return 1
    }

    for (const step of steps) {
      if (shutdownSignal) {
        break
      }

      try {
        updateChildState(handle, { phase: 'spawning', childPid: null })
      } catch (error) {
        console.error(error)
        return 1
      }
      if (shutdownSignal) {
        break
      }

      try {
        currentChild = spawnProcess(step.command, step.args, {
          cwd: step.cwd ?? process.cwd(),
          env: step.env ?? process.env,
          stdio: step.stdio ?? 'inherit',
          detached: platform !== 'win32'
        })
      } catch (error) {
        console.error(error)
        return 1
      }
      const completion = waitForChild(currentChild)

      try {
        if (!currentChild.pid) {
          throw new Error('[heavy-suite] Spawned child has no process id')
        }
        updateChildState(handle, { phase: 'running', childPid: currentChild.pid })
      } catch (error) {
        console.error(error)
        stopCurrentChild('SIGTERM')
        if (currentChild.pid) {
          scheduleForcedKill()
        }
        await completion
        currentChild = null
        return 1
      }

      if (shutdownSignal) {
        stopCurrentChild(shutdownSignal)
        scheduleForcedKill()
      }

      const result = await completion
      currentChild = null
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer)
        forcedKillTimer = null
      }
      try {
        updateChildState(handle, { phase: 'idle', childPid: null })
      } catch (error) {
        console.error(error)
        return 1
      }
      if (result.error) {
        console.error(result.error)
        return 1
      }
      if (shutdownSignal) {
        return signalExitCode(shutdownSignal)
      }
      if (result.signal) {
        return signalExitCode(result.signal)
      }
      if (result.code !== 0) {
        return result.code ?? 1
      }
    }
    return shutdownSignal ? signalExitCode(shutdownSignal) : terminationErrors.length > 0 ? 1 : 0
  }

  let result
  let executionError = null
  try {
    result = await executeSteps()
  } catch (error) {
    executionError = error
  }

  let cleanupError = null
  try {
    await cleanupRun()
  } catch (error) {
    cleanupError = error
  }

  if (forcedKillTimer) {
    clearTimeout(forcedKillTimer)
  }
  for (const [signal, handler] of signalHandlers) {
    signalSource.off(signal, handler)
  }
  if (!releaseHeavySuiteLock(handle)) {
    throw new Error('[heavy-suite] Refused to release a lock no longer owned by this run')
  }
  if (executionError && cleanupError) {
    throw new AggregateError(
      [executionError, cleanupError],
      '[heavy-suite] Execution and owned cleanup both failed'
    )
  }
  if (cleanupError) {
    throw cleanupError
  }
  if (executionError) {
    throw executionError
  }
  return result
}

function packageManagerStep(args, env = process.env) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, ...args],
      cwd: repoRoot,
      env
    }
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args,
    cwd: repoRoot,
    env
  }
}

export function normalizeForwardedArgs(forwardedArgs) {
  const delimiterIndex = forwardedArgs.indexOf('--')
  if (delimiterIndex === -1) {
    return forwardedArgs
  }
  return [...forwardedArgs.slice(0, delimiterIndex), ...forwardedArgs.slice(delimiterIndex + 1)]
}

const electronSuitePresets = {
  'electron-e2e': ({ env, forwardedArgs }) => ({ env, forwardedArgs }),
  'electron-e2e-terminal-scale': ({ env, forwardedArgs }) => ({
    env: {
      ...env,
      ORCA_E2E_OPENCODE_SCALE_PANES: env.ORCA_E2E_OPENCODE_SCALE_PANES ?? '10,25,50,100',
      ORCA_E2E_OPENCODE_SCALE_CROSS_WORKSPACE_PANES:
        env.ORCA_E2E_OPENCODE_SCALE_CROSS_WORKSPACE_PANES ?? '10,25,50,100',
      ORCA_E2E_OPENCODE_SCALE_PRESSURE_PANES: env.ORCA_E2E_OPENCODE_SCALE_PRESSURE_PANES ?? '25,50',
      ORCA_E2E_OPENCODE_SCALE_HIDDEN_PRESSURE_PANES:
        env.ORCA_E2E_OPENCODE_SCALE_HIDDEN_PRESSURE_PANES ?? '25',
      ORCA_E2E_OPENCODE_FRAME_COUNT: env.ORCA_E2E_OPENCODE_FRAME_COUNT ?? '60'
    },
    forwardedArgs: [
      'tests/e2e/artificial-opencode-terminal-load.spec.ts',
      '--project=electron-headless',
      '--workers=1',
      ...forwardedArgs
    ]
  }),
  'electron-e2e-ssh-docker-perf': ({ env, forwardedArgs }) => ({
    env: { ...env, ORCA_E2E_SSH_DOCKER: '1' },
    forwardedArgs: [
      'tests/e2e/ssh-docker-relay-perf.spec.ts',
      '--project=electron-headless',
      '--workers=1',
      ...forwardedArgs
    ]
  }),
  'electron-e2e-ssh-docker-watcher': ({ env, forwardedArgs }) => ({
    env: { ...env, ORCA_E2E_SSH_DOCKER: '1' },
    forwardedArgs: [
      'tests/e2e/ssh-docker-watcher-isolation.spec.ts',
      '--project=electron-headless',
      '--workers=1',
      ...forwardedArgs
    ]
  }),
  'electron-e2e-ssh-codex-artifacts': ({ env, forwardedArgs }) => ({
    env: { ...env, ORCA_E2E_SSH_DOCKER: '1' },
    forwardedArgs: [
      'tests/e2e/ssh-codex-display-artifacts-repro.spec.ts',
      '--project=electron-headless',
      '--workers=1',
      ...forwardedArgs
    ]
  }),
  'electron-e2e-multi-workspace-typing': ({ env, forwardedArgs }) => {
    const knobByFlag = {
      '--panes': 'ORCA_TYPING_BENCH_LOAD_PANES',
      '--rate-kbps': 'ORCA_TYPING_BENCH_RATE_KBPS',
      '--keys': 'ORCA_TYPING_BENCH_KEYS',
      '--cadence-ms': 'ORCA_TYPING_BENCH_KEY_CADENCE_MS',
      '--cpu-workers': 'ORCA_TYPING_BENCH_CPU_WORKERS',
      '--label': 'ORCA_TYPING_BENCH_LABEL'
    }
    const suiteEnv = { ...env, ORCA_TYPING_BENCH: '1' }
    const passthroughArgs = []
    for (let index = 0; index < forwardedArgs.length; index += 1) {
      const knob = knobByFlag[forwardedArgs[index]]
      if (knob) {
        const value = forwardedArgs[index + 1]
        if (!value) {
          throw new Error(`${forwardedArgs[index]} requires a value`)
        }
        suiteEnv[knob] = value
        index += 1
      } else {
        passthroughArgs.push(forwardedArgs[index])
      }
    }
    return {
      env: suiteEnv,
      forwardedArgs: [
        'tests/e2e/terminal-multi-workspace-typing-latency.spec.ts',
        '--project=electron-headless',
        '--workers=1',
        ...passthroughArgs
      ]
    }
  }
}

export function resolveSuitePlan(suite, rawForwardedArgs, options = {}) {
  let forwardedArgs = normalizeForwardedArgs(rawForwardedArgs)
  const runtime = suite === 'unit' || suite === 'computer-e2e' ? 'node' : 'electron'
  let suiteEnv = { ...(options.env ?? process.env) }
  const ensureRuntime = {
    command: process.execPath,
    args: [path.join(repoRoot, 'config/scripts/ensure-native-runtime.mjs'), `--runtime=${runtime}`],
    cwd: repoRoot,
    env: suiteEnv
  }
  if (suite === 'unit') {
    return {
      steps: [
        ensureRuntime,
        packageManagerStep(
          ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', ...forwardedArgs],
          suiteEnv
        )
      ]
    }
  }
  if (suite === 'computer-e2e') {
    return {
      steps: [
        ensureRuntime,
        packageManagerStep(
          ['exec', 'vitest', 'run', '--config', 'tests/e2e/vitest.config.ts', ...forwardedArgs],
          suiteEnv
        )
      ]
    }
  }
  const electronPreset = electronSuitePresets[suite]
  if (electronPreset) {
    ;({ env: suiteEnv, forwardedArgs } = electronPreset({ env: suiteEnv, forwardedArgs }))
    ensureRuntime.env = suiteEnv
    let preparedScope = null
    const playwrightStep = packageManagerStep(
      ['exec', 'playwright', 'test', '--config', 'tests/playwright.config.ts', ...forwardedArgs],
      suiteEnv
    )
    playwrightStep.stdio = options.playwrightStdio
    return {
      steps: [ensureRuntime, playwrightStep],
      prepareRun: () => {
        preparedScope = prepareE2ERunScope({ env: suiteEnv })
      },
      cleanupRun: () => {
        if (preparedScope) {
          cleanupE2ERunScope(preparedScope.scope, { allowMissingManifest: true })
        }
      }
    }
  }
  throw new Error(`Unknown heavy test suite: ${suite}`)
}

async function main() {
  const [suite, ...forwardedArgs] = process.argv.slice(2)
  if (!suite) {
    console.error(
      `Usage: node config/scripts/run-heavy-test-suite.mjs <${[
        'unit',
        'computer-e2e',
        ...Object.keys(electronSuitePresets)
      ].join('|')}> [args]`
    )
    return 1
  }
  const plan = resolveSuitePlan(suite, forwardedArgs)
  return runHeavyTestSuite({ suite, ...plan })
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
