import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  appendProcessOutputTail,
  attachBoundedProcessLineReader
} from './bounded-process-line-reader.mjs'

function primaryLanIp(lanIpCandidates) {
  return lanIpCandidates()[0] || '127.0.0.1'
}

export async function startHeadlessPairingRuntime({
  enabled,
  orcaCli,
  cwd,
  lanIpCandidates,
  logStep,
  logSuccess
}) {
  if (!enabled) {
    return null
  }

  logStep('0', 'Starting temporary desktop runtime for mobile pairing...')
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'orca-mobile-run.'))
  const userData = path.join(runDir, 'userData')
  // Why: the main-process E2E boot guard refuses to start with the real user
  // home, so the pairing runtime must hand it a matching disposable HOME.
  const homeDir = path.join(runDir, 'home')
  mkdirSync(homeDir, { recursive: true, mode: 0o700 })
  const pairingAddress = primaryLanIp(lanIpCandidates)
  const child = spawn(
    orcaCli,
    ['serve', '--mobile-pairing', '--pairing-address', pairingAddress, '--json'],
    {
      cwd,
      env: {
        ...process.env,
        ORCA_E2E_USER_DATA_DIR: userData,
        ORCA_E2E_HOME_DIR: homeDir,
        HOME: homeDir,
        USERPROFILE: homeDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  return await waitForPairingRuntime({ child, userData, pairingAddress, logSuccess })
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
}

async function waitForPairingRuntime({ child, userData, pairingAddress, logSuccess }) {
  let output = ''
  let stderr = ''
  let resolved = false
  let exited = false
  let closeStdout = () => {}
  let closeStderr = () => {}

  const stop = () => {
    if (!exited) {
      child.kill('SIGTERM')
    }
    closeStdout()
    closeStderr()
    child.stdout?.destroy()
    child.stderr?.destroy()
  }

  const runtimeResult = (pairingUrl) => ({
    pairingUrl,
    userData,
    process: child,
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userData
    },
    stop
  })

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

    closeStdout = attachBoundedProcessLineReader(child.stdout, (line) => {
      if (!resolved) {
        output = appendProcessOutputTail(output, line)
      }
      handleRuntimeLine(line, finishResolve)
    })

    closeStderr = attachBoundedProcessLineReader(child.stderr, (line) => {
      if (!resolved) {
        stderr = appendProcessOutputTail(stderr, line)
      }
    })

    child.on('error', (error) => {
      finishReject(new Error(`Failed to start temporary desktop runtime: ${error.message}`))
    })

    child.on('exit', (code) => {
      exited = true
      if (!resolved) {
        const detail = stderr.trim() || output.trim() || `exit code ${code}`
        finishReject(new Error(`Temporary desktop runtime exited before pairing: ${detail}`))
      }
    })
  })
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
