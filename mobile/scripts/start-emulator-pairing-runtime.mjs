import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { createEmulatorPairingChildEnvironment } from './emulator-pairing-child-environment.mjs'
import { linkEmulatorMacKeychain } from './emulator-macos-keychain-home.mjs'
import { seedEmulatorAgentHistoryFixture } from './emulator-agent-history-fixture.mjs'
import { pairingEndpointPortFromUrl } from './emulator-pairing-public-key.mjs'
import {
  currentPairingDaemonPids,
  pairingDaemonPidsFromUserData,
  pairingRuntimePidFromUserData,
  signalPairingDaemons,
  signalPairingRuntime
} from './emulator-pairing-runtime-process.mjs'

function primaryLanIp(lanIpCandidates) {
  return lanIpCandidates()[0] || '127.0.0.1'
}

export async function startHeadlessPairingRuntime({
  enabled,
  orcaCli,
  cwd,
  runDirectory,
  port,
  environment,
  lanIpCandidates,
  logStep,
  logSuccess
}) {
  if (!enabled) {
    return null
  }

  logStep('0', 'Starting temporary desktop runtime for mobile pairing...')
  const runDir = runDirectory
    ? path.resolve(runDirectory)
    : mkdtempSync(path.join(os.tmpdir(), 'orca-mobile-run.'))
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const userData = path.join(runDir, 'userData')
  // Why: the main-process E2E boot guard refuses to start with the real user
  // home, so the pairing runtime must hand it a matching disposable HOME.
  const homeDir = path.join(runDir, 'home')
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  // Keep the disposable home boundary while letting macOS reuse Orca Dev's approved safeStorage item.
  linkEmulatorMacKeychain(homeDir)
  const pairingAddress = primaryLanIp(lanIpCandidates)
  const child = spawn(
    orcaCli,
    [
      'serve',
      '--mobile-pairing',
      '--pairing-address',
      pairingAddress,
      ...(port ? ['--port', String(port)] : []),
      '--json'
    ],
    {
      cwd,
      env: createEmulatorPairingChildEnvironment({
        inheritedEnvironment: process.env,
        environment,
        userData,
        homeDir
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  return await waitForPairingRuntime({
    child,
    environment,
    userData,
    homeDir,
    pairingAddress,
    logSuccess
  })
}

export async function registerWorktreeForPairingRuntime(runtime, worktree, tools) {
  if (!runtime) {
    return
  }
  tools.logStep('0.1', 'Registering current worktree in temporary runtime...')
  await tools.orca(['repo', 'add', '--path', worktree, '--json'], {
    cwd: worktree,
    env: runtime.env,
    timeout: 60000
  })
  tools.logSuccess('Registered worktree for mobile runtime')
  tools.logStep('0.2', 'Creating a visible mobile test terminal...')
  await tools.orca(
    [
      'terminal',
      'create',
      '--worktree',
      `path:${worktree}`,
      '--title',
      'Mobile Emulator',
      '--json'
    ],
    {
      cwd: worktree,
      env: runtime.env,
      timeout: 60000
    }
  )
  tools.logSuccess('Created mobile test terminal')
  if (runtime.env.ORCA_E2E_MOBILE_AGENT_HISTORY_FIXTURE === '1') {
    seedEmulatorAgentHistoryFixture({
      homeDir: runtime.homeDir,
      workspacePath: worktree
    })
    tools.logSuccess('Created Agent History fixture')
  }
}

async function waitForPairingRuntime({
  child,
  environment,
  userData,
  homeDir,
  pairingAddress,
  logSuccess
}) {
  let output = ''
  let stderr = ''
  let resolved = false
  let exited = false
  let closeStdout = () => {}
  let closeStderr = () => {}
  let resolveExit = () => {}
  let runtimePid = null
  let daemonPids = []
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve
  })

  const stop = async ({ shutdownDaemon = false } = {}) => {
    signalPairingRuntime(runtimePid)
    if (!exited) {
      child.kill('SIGTERM')
    }
    await Promise.race([exitPromise, delay(5_000)])
    closeStdout()
    closeStderr()
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (shutdownDaemon) {
      daemonPids = currentPairingDaemonPids(userData, daemonPids)
      signalPairingDaemons(daemonPids)
      const gracefulTimeouts = await waitForProcessExit(daemonPids, 2_500)
      signalPairingDaemons(gracefulTimeouts, process.kill, 'SIGKILL')
      const forcedTimeouts = await waitForProcessExit(gracefulTimeouts, 2_500)
      if (forcedTimeouts.length > 0) {
        throw new Error(`Temporary pairing daemons did not exit: ${forcedTimeouts.join(', ')}`)
      }
    }
  }

  const runtimeResult = (pairingUrl) => {
    runtimePid = pairingRuntimePidFromUserData(userData)
    daemonPids = pairingDaemonPidsFromUserData(userData)
    return {
      pairingUrl,
      port: pairingEndpointPortFromUrl(pairingUrl),
      userData,
      homeDir,
      process: child,
      env: {
        ...process.env,
        ...environment,
        ORCA_USER_DATA_PATH: userData,
        // Why: `orca-dev` derives its own profile and ignores ORCA_USER_DATA_PATH.
        ORCA_DEV_USER_DATA_PATH: userData
      },
      stop
    }
  }

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        stop()
        reject(new Error('Timeout waiting for temporary desktop runtime pairing URL'))
      }
    }, 120000)

    const finishResolve = (pairingUrl) => {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(timeout)
      logSuccess(`Temporary desktop runtime ready (${pairingAddress})`)
      resolve(runtimeResult(pairingUrl))
    }

    const finishReject = (error) => {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(timeout)
      stop()
      reject(error)
    }

    const rl = readline.createInterface({ input: child.stdout })
    closeStdout = () => rl.close()
    rl.on('line', (line) => {
      output += line + '\n'
      handleRuntimeLine(line, finishResolve)
    })

    const rlErr = readline.createInterface({ input: child.stderr })
    closeStderr = () => rlErr.close()
    rlErr.on('line', (line) => {
      stderr += line + '\n'
    })

    child.on('error', (error) => {
      finishReject(new Error(`Failed to start temporary desktop runtime: ${error.message}`))
    })

    child.on('exit', (code) => {
      exited = true
      resolveExit()
      if (!resolved) {
        const detail = stderr.trim() || output.trim() || `exit code ${code}`
        finishReject(new Error(`Temporary desktop runtime exited before pairing: ${detail}`))
      }
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForProcessExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await delay(50)
  }
  return pids.filter(isProcessAlive)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function handleRuntimeLine(line, finishResolve) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) {
    return
  }
  try {
    const result = JSON.parse(trimmed)
    const pairingUrl = result?.pairing?.url
    if (typeof pairingUrl === 'string' && pairingUrl.length > 0) {
      finishResolve(pairingUrl)
    }
  } catch {
    // Ignore non-JSON log lines from Electron startup.
  }
}
