import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
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
const STABLE_NAME_FLAG = '--stable-name'
const rawForwardedArgs = process.argv.slice(2)
// Why: keep an escape hatch for tools that key off Electron's stock app name.
// The flag is runner-only and must not leak into Chromium/electron-vite.
const useStableElectronName =
  process.env.ORCA_DEV_STABLE_NAME === '1' || rawForwardedArgs.includes(STABLE_NAME_FLAG)
const forwardedRaw = rawForwardedArgs.filter((arg) => arg !== STABLE_NAME_FLAG)
if (useStableElectronName) {
  process.env.ORCA_DEV_STABLE_NAME = '1'
}

function readGitValue(args) {
  try {
    const value = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return value || null
  } catch {
    return null
  }
}

function lastBranchSegment(value) {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? value
}

function formatDevInstanceLabel(branch, worktreeName) {
  if (branch && worktreeName) {
    if (branch === worktreeName || lastBranchSegment(branch) === worktreeName) {
      return worktreeName
    }
    return `${worktreeName} @ ${branch}`
  }
  return branch || worktreeName || null
}

function createDockTitle(branch, label) {
  return `Orca: ${branch || label || 'dev'}`
}

function seedDevInstanceIdentityEnv() {
  const branch =
    process.env.ORCA_DEV_BRANCH ||
    readGitValue(['symbolic-ref', '--quiet', '--short', 'HEAD']) ||
    readGitValue(['rev-parse', '--short', 'HEAD'])
  const worktreeName = process.env.ORCA_DEV_WORKTREE_NAME || path.basename(repoRoot)
  const label = process.env.ORCA_DEV_INSTANCE_LABEL || formatDevInstanceLabel(branch, worktreeName)
  const identitySeed = process.env.ORCA_DEV_INSTANCE_KEY || repoRoot
  const dockTitle = process.env.ORCA_DEV_DOCK_TITLE || createDockTitle(branch, label)

  process.env.ORCA_DEV_REPO_ROOT ||= repoRoot
  process.env.ORCA_DEV_INSTANCE_KEY ||= identitySeed
  if (branch) {
    process.env.ORCA_DEV_BRANCH ||= branch
  }
  if (worktreeName) {
    process.env.ORCA_DEV_WORKTREE_NAME ||= worktreeName
  }
  if (label) {
    // Why: parallel `pn dev` runs need a stable origin label for window titles,
    // Dock names, and automation sessions without re-running git in Electron.
    process.env.ORCA_DEV_INSTANCE_LABEL ||= label
  }
  process.env.ORCA_DEV_DOCK_TITLE ||= dockTitle
}

function setPlistValue(plistPath, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath])
}

function sanitizeBundleIdPart(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'dev'
  )
}

function sanitizeMacAppBundleName(value) {
  return (
    Array.from(value, (char) => {
      const code = char.charCodeAt(0)
      return code < 32 || code === 127 || char === '/' || char === '\\' ? '-' : char
    })
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Orca'
  )
}

function prepareMacDevElectronApp() {
  if (process.platform !== 'darwin') {
    return
  }

  const sourceAppPath = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
  const electronPackagePath = path.join(repoRoot, 'node_modules', 'electron', 'package.json')
  if (!existsSync(sourceAppPath)) {
    return
  }

  let electronVersion = null
  try {
    electronVersion = JSON.parse(readFileSync(electronPackagePath, 'utf8')).version ?? null
  } catch {}

  const title = process.env.ORCA_DEV_DOCK_TITLE || 'Orca: dev'
  const identityKey = process.env.ORCA_DEV_INSTANCE_KEY || repoRoot
  const bundleLayoutVersion = 'dock-title-app-preserve-framework-symlinks-v4'
  const hash = createHash('sha1')
    .update(
      `${sourceAppPath}\0${electronVersion ?? ''}\0${title}\0${identityKey}\0${bundleLayoutVersion}`
    )
    .digest('hex')
    .slice(0, 12)
  const distDir = path.join(repoRoot, 'out', 'electron-dev', hash)
  // Why: macOS Dock hover uses the bundle's filesystem display name for
  // electron-vite's direct binary launch path, even when Info.plist is patched.
  const appBundleName = `${sanitizeMacAppBundleName(title)}.app`
  const appPath = path.join(distDir, appBundleName)
  const markerPath = path.join(distDir, 'orca-dev-electron-app.json')
  const bundleId = `com.stablyai.orca.dev.${sanitizeBundleIdPart(hash)}`
  process.env.ORCA_DEV_MACOS_BUNDLE_ID = bundleId
  const expectedMarker = JSON.stringify(
    { title, appBundleName, bundleId, sourceAppPath, electronVersion, bundleLayoutVersion },
    null,
    2
  )
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Electron')
  const requiredResourcePaths = [
    path.join(
      appPath,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Resources',
      'icudtl.dat'
    )
  ]

  function copiedAppIsUsable() {
    if (!existsSync(markerPath) || !existsSync(appPath)) {
      return false
    }
    try {
      if (readFileSync(markerPath, 'utf8') !== expectedMarker) {
        return false
      }
    } catch {
      return false
    }
    // Why: a previous interrupted copy can leave the marker and executable
    // present but miss Chromium framework resources, causing a blank crash.
    return (
      existsSync(executablePath) &&
      requiredResourcePaths.every((resourcePath) => existsSync(resourcePath))
    )
  }

  if (copiedAppIsUsable()) {
    process.env.ELECTRON_EXEC_PATH = executablePath
    return
  }

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })
  // Why: Electron.framework uses relative symlinks for its bundle resources;
  // resolving them to pnpm-store absolutes breaks Chromium's bundle lookup.
  cpSync(sourceAppPath, appPath, { recursive: true, verbatimSymlinks: true })
  restoreElectronFrameworkSymlinks(appPath)

  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  setPlistValue(plistPath, 'CFBundleName', title)
  setPlistValue(plistPath, 'CFBundleDisplayName', title)
  setPlistValue(plistPath, 'CFBundleIdentifier', bundleId)

  // Why no re-sign: dev launches execute the copied Electron binary directly,
  // and Electron's framework bundle is ambiguous to codesign when deep-signing
  // an already-built distribution. Avoid blocking `pn dev` on local signing.
  writeFileSync(markerPath, expectedMarker, 'utf8')
  process.env.ELECTRON_EXEC_PATH = executablePath
}

function isSymlink(filePath) {
  try {
    return lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

function ensureRelativeSymlink(linkPath, target) {
  if (isSymlink(linkPath)) {
    try {
      if (readlinkSync(linkPath) === target) {
        return
      }
    } catch {}
  }

  const targetPath = path.join(path.dirname(linkPath), target)
  if (!existsSync(targetPath)) {
    return
  }

  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath)
}

function restoreElectronFrameworkSymlinks(appPath) {
  const frameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework')
  const versionsPath = path.join(frameworkPath, 'Versions')
  if (!existsSync(path.join(versionsPath, 'A'))) {
    return
  }

  // Why: some Electron installs have framework symlinks flattened into
  // duplicate directories. Recreate the relative bundle links after copying so
  // Chromium resolves resources through the canonical macOS framework layout.
  ensureRelativeSymlink(path.join(versionsPath, 'Current'), 'A')
  for (const entry of ['Electron Framework', 'Resources', 'Libraries', 'Helpers']) {
    ensureRelativeSymlink(path.join(frameworkPath, entry), `Versions/Current/${entry}`)
  }
}

function getDevUserDataPath() {
  if (process.env.ORCA_DEV_USER_DATA_PATH) {
    return process.env.ORCA_DEV_USER_DATA_PATH
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'orca-dev')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      'orca-dev'
    )
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'),
    'orca-dev'
  )
}

function prepareDevCliWrapper() {
  const binDir = path.join(repoRoot, 'out', 'bin')
  mkdirSync(binDir, { recursive: true })
  const userDataPath = getDevUserDataPath()
  const cliPath = path.join(repoRoot, 'out', 'cli', 'index.js')
  const electronBin = getElectronExecutable()

  if (process.platform === 'win32') {
    writeFileSync(
      path.join(binDir, 'orca-dev.cmd'),
      `@echo off\r\nset "ORCA_USER_DATA_PATH=${userDataPath}"\r\nset "ORCA_APP_EXECUTABLE=${electronBin}"\r\nset "ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1"\r\nnode "${cliPath}" %*\r\n`,
      'utf8'
    )
  } else {
    const wrapperPath = path.join(binDir, 'orca-dev')
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env bash\nexport ORCA_USER_DATA_PATH=${JSON.stringify(userDataPath)}\nexport ORCA_APP_EXECUTABLE=${JSON.stringify(electronBin)}\nexport ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT=1\nexec node ${JSON.stringify(cliPath)} "$@"\n`,
      'utf8'
    )
    chmodSync(wrapperPath, 0o755)
  }

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  console.log(`[orca-dev] Prepared wrapper in ${binDir}`)
}

function getElectronExecutable() {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(repoRoot, 'node_modules', '.bin', 'electron')
}

if (process.env.ORCA_SKIP_DEV_CLI_PREPARE !== '1') {
  prepareDevCliWrapper()
}

seedDevInstanceIdentityEnv()
if (!useStableElectronName && process.env.ORCA_SKIP_DEV_ELECTRON_APP_PREPARE !== '1') {
  prepareMacDevElectronApp()
}

// Why: tests inject a tiny fake CLI here so they can verify Ctrl+C tears down
// the full child tree without depending on a real electron-vite install.
const electronViteCli =
  process.env.ORCA_ELECTRON_VITE_CLI ||
  path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const viteCli =
  process.env.ORCA_VITE_CLI ||
  path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js')

function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function getDevWebClientIndexPath() {
  return path.join(repoRoot, 'out', 'web', 'web-index.html')
}

function latestMtimeMs(targetPath) {
  const stat = (() => {
    try {
      return statSync(targetPath)
    } catch {
      return null
    }
  })()
  if (!stat) {
    return 0
  }
  if (!stat.isDirectory()) {
    return stat.mtimeMs
  }
  let latest = stat.mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    latest = Math.max(latest, latestMtimeMs(path.join(targetPath, entry.name)))
  }
  return latest
}

function isDevWebClientFresh() {
  const outputMtime = getMtimeMs(getDevWebClientIndexPath())
  if (outputMtime === 0) {
    return false
  }
  const sourceMtime = Math.max(
    latestMtimeMs(path.join(repoRoot, 'vite.web.config.ts')),
    latestMtimeMs(path.join(repoRoot, 'src', 'renderer')),
    latestMtimeMs(path.join(repoRoot, 'src', 'shared')),
    latestMtimeMs(path.join(repoRoot, 'src', 'preload', 'api-types.ts'))
  )
  return sourceMtime <= outputMtime
}

function prepareDevWebClient() {
  if (process.env.ORCA_SKIP_DEV_WEB_PREPARE === '1' || isHelpOrVersion) {
    return
  }
  // Why: fresh worktrees should start Electron immediately; pairing already
  // falls back to non-browser URLs when the optional web bundle is unavailable.
  if (!existsSync(getDevWebClientIndexPath()) && process.env.ORCA_DEV_WEB_PREPARE !== '1') {
    console.error(
      '[orca-dev] Web client bundle missing; skipping pairing web build. Run `pnpm run build:web` or set ORCA_DEV_WEB_PREPARE=1 when you need browser pairing.'
    )
    return
  }
  if (isDevWebClientFresh()) {
    return
  }
  console.error('[orca-dev] Building web client for pairing...')
  execFileSync(
    process.execPath,
    [viteCli, 'build', '--config', path.join(repoRoot, 'vite.web.config.ts')],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env
    }
  )
}

// Why: every `pn dev` should be attachable from agent-browser/playwright-cli
// without manual port juggling. Pick a best-effort deterministic port per
// worktree; falls back to a probe sweep if the deterministic pick or its
// neighbors are busy (multiple worktrees may share a machine).
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => {
      // Why: error fires before listen binds; close() may throw — swallow it
      // so the handle is released without leaking listeners across 64 probes.
      try {
        srv.close()
      } catch {}
      resolve(false)
    })
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}
async function pickDebugPort() {
  // Why: 32 bits of SHA1 (vs 16) reduces truncation bias; modulo 200 still
  // collides routinely across many worktrees, hence the probe sweep below.
  const seed = parseInt(createHash('sha1').update(repoRoot).digest('hex').slice(0, 8), 16)
  const base = 9333 + (seed % 200) // deterministic base in 9333..9532; probe sweeps up to base+63
  for (let i = 0; i < 64; i++) {
    const p = base + i
    if (await isPortFree(p)) {
      return p
    }
  }
  return null
}
function parseDebugPortEnv(raw) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 1 || n > 65535 || String(n) !== raw.trim()) {
    return null
  }
  return n
}
// Why: exact match (or `=` form) avoids false positives on hypothetical
// `--remote-debugging-port-*` flags; the bare flag also covers the
// space-separated form. `--remote-debugging-pipe` opts into pipe-based
// debugging — don't fight the user's choice by injecting a port.
const userPassedPort = forwardedRaw.some(
  (a) =>
    a === '--remote-debugging-port' ||
    a.startsWith('--remote-debugging-port=') ||
    a === '--remote-debugging-pipe'
)
// Why: --help/--version exit immediately; binding a probe socket and printing
// a debug-port line would be noise.
const isHelpOrVersion = forwardedRaw.some((a) => a === '--help' || a === '-h' || a === '--version')
if (!isHelpOrVersion && process.env.ORCA_DEV_INSTANCE_LABEL) {
  console.error(`[orca-dev] Instance: ${process.env.ORCA_DEV_INSTANCE_LABEL}`)
}
let forwardedExtras = []
if (!userPassedPort && !isHelpOrVersion) {
  const envPortRaw = process.env.REMOTE_DEBUGGING_PORT
  let port = null
  if (envPortRaw) {
    port = parseDebugPortEnv(envPortRaw)
    if (port === null) {
      console.error(
        `[orca-dev] Ignoring invalid REMOTE_DEBUGGING_PORT=${JSON.stringify(envPortRaw)}; falling back to probe.`
      )
    }
  }
  if (port === null) {
    port = await pickDebugPort()
  }
  if (port !== null) {
    forwardedExtras = [`--remote-debugging-port=${port}`]
    // Why: stderr keeps stdout clean for downstream parsing; log uses
    // 127.0.0.1 to match the interface we actually probed (localhost may
    // resolve to ::1 on IPv6-first hosts).
    console.error(`[orca-dev] Remote debugging on http://127.0.0.1:${port}`)
  } else {
    console.error(
      '[orca-dev] No free debug port found in sweep; starting without --remote-debugging-port.'
    )
  }
}
prepareDevWebClient()
const forwardedArgs = ['dev', ...forwardedRaw, ...forwardedExtras]
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
