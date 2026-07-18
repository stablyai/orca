import { spawn } from 'node:child_process'

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

export function signalExitCode(signal) {
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

export async function waitForProcessTreeExit(
  childPid,
  { isChildTreeAlive, timeoutMs, pollIntervalMs = 25 }
) {
  const deadline = Date.now() + timeoutMs
  while (isChildTreeAlive(childPid)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)))
  }
  return true
}
