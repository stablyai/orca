import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

export function startHostedIosMobileLauncher({
  deviceUdid,
  emulatorControlUserDataPath,
  environment,
  metroDirectory,
  orcaCli,
  runtimeDirectory,
  worktree
}) {
  return spawn(
    process.execPath,
    [
      path.join(worktree, 'mobile', 'scripts', 'start-emulator.mjs'),
      '--worktree',
      worktree,
      '--device',
      deviceUdid,
      '--wait-for-ready'
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        ...environment,
        ORCA_CLI: orcaCli,
        EXPO_PUBLIC_ORCA_E2E_MOBILE_NATIVE_BASELINE: '1',
        ORCA_E2E_MOBILE_AUTO_SELECT_PAIRED_HOST: '1',
        ORCA_E2E_MOBILE_AGENT_HISTORY_FIXTURE: '1',
        ORCA_E2E_MOBILE_RUN_DIRECTORY: path.join(runtimeDirectory, 'paired-host'),
        ORCA_E2E_MOBILE_RESTART_HOLD_MS: '2000',
        ORCA_E2E_MOBILE_EMULATOR_CONTROL_USER_DATA_PATH: emulatorControlUserDataPath,
        // Why: an old-client A/B serves Metro from another checkout while the paired
        // desktop runtime and the registered workspace stay on this one.
        ...(metroDirectory ? { ORCA_E2E_MOBILE_METRO_DIR: metroDirectory } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
}

export function waitForHostedIosMobileLauncher(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let outputTail = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`Mobile launcher timed out.\n${outputTail}`))
    }, timeoutMs)
    const consume = (chunk, target) => {
      const text = String(chunk)
      target.write(text)
      outputTail = (outputTail + text).slice(-32 * 1024)
      if (outputTail.includes('Setup complete!')) {
        finish()
      }
    }
    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off('exit', handleExit)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const handleExit = (code) => {
      finish(new Error(`Mobile launcher exited with code ${code}.\n${outputTail}`))
    }
    child.stdout.on('data', (chunk) => consume(chunk, process.stdout))
    child.stderr.on('data', (chunk) => consume(chunk, process.stderr))
    child.once('error', finish)
    child.once('exit', handleExit)
  })
}
