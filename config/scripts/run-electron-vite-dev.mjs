import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Why: Electron-based hosts (e.g. Claude Code, VS Code) set
// ELECTRON_RUN_AS_NODE=1 in their terminal environment. If this leaks into
// the electron-vite spawn, the Electron binary boots as plain Node and
// require('electron') returns the npm stub instead of the built-in API.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function getDevUserDataPath() {
  if (process.env.ORCA_DEV_USER_DATA_PATH) {
    return process.env.ORCA_DEV_USER_DATA_PATH
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'orca-dev')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'orca-dev')
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'), 'orca-dev')
}

function prepareDevCliWrapper() {
  const binDir = path.join(repoRoot, 'out', 'bin')
  mkdirSync(binDir, { recursive: true })
  const userDataPath = getDevUserDataPath()
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')

  if (process.platform === 'win32') {
    writeFileSync(
      path.join(binDir, 'orca-dev.cmd'),
      `@echo off\r\nset "ORCA_USER_DATA_PATH=${userDataPath}"\r\nnode "${cliPath}" %*\r\n`,
      'utf8'
    )
  } else {
    const wrapperPath = path.join(binDir, 'orca-dev')
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${JSON.stringify(userDataPath)}\nexec node ${JSON.stringify(cliPath)} "$@"\n`,
      'utf8'
    )
    chmodSync(wrapperPath, 0o755)
  }

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  console.log(`[orca-dev] Prepared wrapper in ${binDir}`)
}

if (process.env.ORCA_SKIP_DEV_CLI_PREPARE !== '1') {
  prepareDevCliWrapper()
}

// Why: tests inject a tiny fake CLI here so they can verify Ctrl+C tears down
// the full child tree without depending on a real electron-vite install.
const electronViteCli =
  process.env.ORCA_ELECTRON_VITE_CLI ||
  path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const forwardedArgs = ['dev', ...process.argv.slice(2)]
const child = spawn(process.execPath, [electronViteCli, ...forwardedArgs], {
  stdio: 'inherit',
  env: process.env,
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
