import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
// Why: tests inject a tiny fake CLI here so they can verify Ctrl+C tears down
// the full child tree without depending on a real electron-vite install.
const electronViteCli =
  process.env.ORCA_ELECTRON_VITE_CLI ||
  path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const forwardedArgs = ['dev', ...process.argv.slice(2)]
const child = spawn(process.execPath, [electronViteCli, ...forwardedArgs], {
  stdio: 'inherit',
  // Why: electron-vite launches Electron as a descendant process. Giving the
  // dev runner its own process group lets Ctrl+C kill the whole tree on macOS
  // instead of leaving the Electron app alive after the terminal exits.
  detached: process.platform !== 'win32'
})

let isShuttingDown = false
let forcedKillTimer = null

function signalExitCode(signal) {
  if (signal === 'SIGINT') {
    return 130
  }
  if (signal === 'SIGTERM') {
    return 143
  }
  return 1
}

function terminateChild(signal) {
  if (!child.pid) {
    return
  }

  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    taskkill.unref()
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'ESRCH') {
      throw error
    }
  }
}

function beginShutdown(signal) {
  if (isShuttingDown) {
    return
  }
  isShuttingDown = true

  terminateChild(signal)
  forcedKillTimer = setTimeout(() => {
    terminateChild('SIGKILL')
  }, 5000)
}

process.on('SIGINT', () => {
  beginShutdown('SIGINT')
})

process.on('SIGTERM', () => {
  beginShutdown('SIGTERM')
})

child.on('error', (error) => {
  if (forcedKillTimer) {
    clearTimeout(forcedKillTimer)
  }
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (forcedKillTimer) {
    clearTimeout(forcedKillTimer)
  }

  if (isShuttingDown) {
    process.exit(signalExitCode(signal ?? 'SIGINT'))
    return
  }

  if (signal) {
    process.exit(signalExitCode(signal))
    return
  }

  process.exit(code ?? 1)
})
