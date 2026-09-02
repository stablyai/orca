import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
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

import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'
import {
  DEV_BUNDLE_MARKER_FILENAME,
  getDevBundleProcessTable,
  isDevBundleInUse,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'
import { copyPrivateTree } from './space-sharing-copy.mjs'
import {
  DEV_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

// Why: Electron-based hosts (e.g. Claude Code, VS Code) set
// ELECTRON_RUN_AS_NODE=1 in their terminal environment. If this leaks into
// the electron-vite spawn, the Electron binary boots as plain Node and
// require('electron') returns the npm stub instead of the built-in API.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '../..')
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
  return value.replace(/\\/g, '/').split('/').findLast(Boolean) ?? value
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

function pruneStaleDevBundles(distDir) {
  const root = path.dirname(distDir)
  let bundles
  try {
    bundles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name)
        return {
          dir,
          hasMarker: existsSync(path.join(dir, DEV_BUNDLE_MARKER_FILENAME)),
          mtimeMs: getMtimeMs(dir)
        }
      })
  } catch {
    return
  }
  if (bundles.length <= 1) {
    return
  }
  const processTable = getDevBundleProcessTable()
  if (processTable === null) {
    return
  }
  const stale = selectStaleDevBundleDirs({
    bundles,
    currentDir: distDir,
    processTable,
    nowMs: Date.now()
  })
  for (const dir of stale) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
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
  // v11: stop patching the branch title into Info.plist so every dev bundle signs to one cdhash.
  // A stale copy only emits extra fields the parser ignores, so narrowing its schema needs no bump.
  const bundleLayoutVersion = 'stable-cdhash-dock-name-from-bundle-dir-v11'
  const hash = createHash('sha1')
    .update(
      `${sourceAppPath}\0${electronVersion ?? ''}\0${title}\0${identityKey}\0${bundleLayoutVersion}`
    )
    .digest('hex')
    .slice(0, 12)
  const distDir = path.join(repoRoot, 'out', 'electron-dev', hash)
  // Why: macOS Dock hover uses the bundle's filesystem display name for electron-vite's direct
  // binary launch path. This is what carries the per-branch name now that Info.plist no longer does,
  // and it sits outside the code signature, so varying it does not disturb the cdhash.
  const appBundleName = `${sanitizeMacAppBundleName(title)}.app`
  const appPath = path.join(distDir, appBundleName)
  const markerPath = path.join(distDir, DEV_BUNDLE_MARKER_FILENAME)
  // Why: one stable id for every dev instance. Per-instance ids registered a
  // new macOS Notification Settings entry for each branch × Electron version,
  // piling up "Orca: <branch>" rows forever and breaking the notification
  // settings deep-link (System Settings can't resolve an id it has no entry
  // for and falls back to the root list). macOS keys notification permission
  // by bundle id, so a single id also means granting notifications to one dev
  // instance covers all of them. Trade-off: when two dev instances run at
  // once, macOS may route a notification click to the other instance —
  // Electron drops clicks for notification ids it didn't create, so the
  // click is lost, not misdirected.
  const bundleId = DEV_BUNDLE_ID
  process.env.ORCA_DEV_MACOS_BUNDLE_ID = bundleId
  // Why the patches are in the marker: bundleLayoutVersion alone does not cover them, so a cache
  // built before a patch value changed would be reused and keep presenting the old identity.
  const expectedMarker = JSON.stringify(
    {
      title,
      appBundleName,
      bundleId,
      sourceAppPath,
      electronVersion,
      bundleLayoutVersion,
      plistPatches: [...getDevBundlePlistPatches(), ...getDevHelperPlistPatches()]
    },
    null,
    2
  )
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Electron')
  // Split by consequence: without this Chromium blank-crashes, so it gates whether the bundle can
  // run at all. The keyboard-layout helper below is optional -- swiftc builds it non-fatally, so on
  // a Mac without full Xcode it is simply absent and only a keyboard feature degrades.
  const chromiumResourcePath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Resources',
    'icudtl.dat'
  )
  const requiredResourcePaths = [
    chromiumResourcePath,
    path.join(appPath, 'Contents', 'MacOS', 'orca-keyboard-layout')
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
    pruneStaleDevBundles(distDir)
    process.env.ELECTRON_EXEC_PATH = executablePath
    return
  }

  // Why this guard: a rebuild replaces this exact directory, and making the marker conditional on a
  // successful sign means an unsigned bundle is a permanent cache miss -- so every later run would
  // reach this rmSync while another instance is still running from it, deleting its app mid-session.
  // Reusing what is there matches what the runner did before the marker became conditional.
  const rebuildProcessTable = getDevBundleProcessTable()
  if (
    rebuildProcessTable !== null &&
    isDevBundleInUse(distDir, rebuildProcessTable) &&
    // Why a runnability check: a bundle missing Chromium's resources blank-crashes, and its
    // orphaned crashpad helper still matches the process table -- so without this the runner would
    // reuse a broken bundle forever and never rebuild itself out. Deliberately narrower than
    // copiedAppIsUsable, which also demands the optional keyboard-layout helper: gating on that
    // would strand every Mac without swiftc back on the rmSync path this guard exists to avoid.
    existsSync(executablePath) &&
    existsSync(chromiumResourcePath)
  ) {
    console.warn(
      `[orca-dev] Another dev instance is running from this bundle; reusing it instead of rebuilding. Quit the other instance (or delete ${distDir}) to force a rebuild.`
    )
    process.env.ELECTRON_EXEC_PATH = executablePath
    return
  }

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })
  // Why clone-first: this ~280MB copy is made per branch title x Electron version, and only the
  // plist/helper/codesign bytes patched below ever diverge from the source.
  copyPrivateTree(sourceAppPath, appPath)
  restoreElectronFrameworkSymlinks(appPath)

  const plistPath = path.join(appPath, 'Contents', 'Info.plist')
  const helperPlistPath = path.join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Helper.app',
    'Contents',
    'Info.plist'
  )
  // Why every value here is constant: Info.plist is inside the signature seal, so a branch-varying
  // value (these keys used to carry the branch title) changed the ad-hoc cdhash per branch, and
  // macOS Keychain ACLs match on that cdhash — every branch read as a different app and re-prompted.
  // Patching these keys is fine; varying them is not. The Dock takes its label from the .app
  // directory name (see appBundleName), which is outside the signature, so per-branch names survive.
  for (const { key, value } of getDevBundlePlistPatches()) {
    setPlistValue(plistPath, key, value)
  }
  for (const { key, value } of getDevHelperPlistPatches()) {
    setPlistValue(helperPlistPath, key, value)
  }

  // Why: the notification-status helper reads the app's real macOS
  // notification authorization (UNUserNotificationCenter has no Electron
  // API). It must live inside the bundle and carry the dev bundle id as its
  // embedded/code-sign identifier — macOS keys notification records to the
  // signing identifier. Non-fatal: without swiftc the permission card falls
  // back to delivery-probe heuristics.
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'build-notification-status-macos.mjs'),
        '--bundle-id',
        bundleId,
        '--single-arch',
        '--output',
        path.join(appPath, 'Contents', 'MacOS', 'orca-notification-status')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[orca-dev] notification-status helper build failed (permission card falls back to probes): ${error?.message ?? error}`
    )
  }

  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'config', 'scripts', 'build-keyboard-layout-macos.mjs'),
        '--single-arch',
        '--output',
        path.join(appPath, 'Contents', 'MacOS', 'orca-keyboard-layout')
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    console.warn(
      `[orca-dev] keyboard-layout helper build failed (shifted Option composition stays conservative): ${error?.message ?? error}`
    )
  }

  // Why: the plist edits above (and the copy itself) break the bundle's
  // ad-hoc seal, and macOS refuses Notification Center registration for
  // invalidly-signed apps — every dev notification fails with UNErrorDomain
  // error 1 and the app never appears in System Settings > Notifications.
  // An ad-hoc re-sign restores delivery, the permission prompt, and the
  // notification-settings deep link for dev builds. Non-fatal: a signing
  // failure should not block `pnpm dev`.
  let signed = true
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
  } catch (error) {
    signed = false
    console.warn(
      `[orca-dev] ad-hoc codesign failed (dev notifications will not deliver): ${error?.message ?? error}`
    )
  }
  // Why only when signed: the marker is what marks this bundle reusable. Writing it after a failed
  // sign cached an unsigned bundle permanently -- the warning above scrolled past once and every
  // later launch silently reused it, losing notification delivery and the stable cdhash that keeps
  // safeStorage from re-prompting. Leaving it unwritten costs a re-copy per launch until signing
  // works, and still does not block `pnpm dev`.
  if (signed) {
    writeFileSync(markerPath, expectedMarker, 'utf8')
  }
  pruneStaleDevBundles(distDir)
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
  const userDataPath = getDevUserDataPath()
  const { binDir } = prepareDevCliTerminalWrappers({
    repoRoot,
    userDataPath,
    electronExecutable: getElectronExecutable()
  })

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
  const seed = Number.parseInt(createHash('sha1').update(repoRoot).digest('hex').slice(0, 8), 16)
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
// Why: automation launches this app while someone is working; announce that the
// window will come up without taking the foreground so the mode is visible in logs.
if (!isHelpOrVersion && process.env.ORCA_BACKGROUND_LAUNCH === '1') {
  console.error('[orca-dev] Background launch: window shows without stealing focus')
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
