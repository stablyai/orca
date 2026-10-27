import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'
import {
  DEV_BUNDLE_MARKER_FILENAME,
  getDevBundleProcessTable,
  isDevBundleInUse,
  selectStaleDevBundleDirs
} from './dev-electron-bundle-cache.mjs'
import { startDevStorageReclaim } from './dev-storage-reclaim.mjs'
import {
  announceDevInstance,
  dropInheritedDevInstanceEnv,
  resolveDevInstancePorts,
  resolveDevProfile,
  writeWorktreeProfileMarker
} from './dev-instance-isolation.mjs'
import { getDefaultSeedSource, profileHasState, seedDevProfile } from './dev-profile-seed.mjs'
import {
  captureDevWebClientInputs,
  isDevWebClientFresh,
  recordDevWebClientInputs
} from './dev-web-client-freshness.mjs'
import { withRolldownThreadLimit } from './rolldown-thread-limit.mjs'
import { withDevRolldownRuntimeEnv } from './dev-rolldown-runtime-env.mjs'
import { copyPrivateTree } from './space-sharing-copy.mjs'
import { buildDevSwiftCliHelpers } from './swift-cli-helper-macos.mjs'
import {
  DEV_BUNDLE_ID,
  getDevBundlePlistPatches,
  getDevHelperPlistPatches
} from './dev-electron-bundle-identity.mjs'

// Clear inherited ELECTRON_RUN_AS_NODE from Electron-hosted terminals or child boots plain Node and returns npm electron stub.
delete process.env.ELECTRON_RUN_AS_NODE

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '../..')
const STABLE_NAME_FLAG = '--stable-name'
const rawForwardedArgs = process.argv.slice(2)
// Runner-only escape hatch for tools requiring stock Electron name; never forward to Chromium/electron-vite.
const useStableElectronName =
  process.env.ORCA_DEV_STABLE_NAME === '1' || rawForwardedArgs.includes(STABLE_NAME_FLAG)
const SHARED_PROFILE_FLAG = '--shared-profile'
const WORKTREE_PROFILE_FLAG = '--worktree-profile'
const SEED_PROFILE_FLAG = '--seed-profile'
const isSeedProfileArg = (arg) =>
  arg === SEED_PROFILE_FLAG || arg.startsWith(`${SEED_PROFILE_FLAG}=`)
const seedProfileArg = rawForwardedArgs.findLast(isSeedProfileArg)
// Why: profile flags are runner-only, like --stable-name.
const forwardedRaw = rawForwardedArgs.filter(
  (arg) =>
    arg !== STABLE_NAME_FLAG &&
    arg !== SHARED_PROFILE_FLAG &&
    arg !== WORKTREE_PROFILE_FLAG &&
    !isSeedProfileArg(arg)
)
const requestedProfileMode = rawForwardedArgs.includes(SHARED_PROFILE_FLAG)
  ? 'shared'
  : rawForwardedArgs.includes(WORKTREE_PROFILE_FLAG)
    ? 'worktree'
    : undefined
// `--seed-profile` uses the default source; `--seed-profile=<dir>` or ORCA_DEV_SEED_PROFILE=<dir|1> pick one.
const seedProfileRequest =
  seedProfileArg?.slice(SEED_PROFILE_FLAG.length + 1) ?? process.env.ORCA_DEV_SEED_PROFILE ?? null
if (useStableElectronName) {
  process.env.ORCA_DEV_STABLE_NAME = '1'
}
// Why: --help/--version exit immediately; binding probe sockets or printing instance lines is noise.
const isHelpOrVersion = forwardedRaw.some((a) => a === '--help' || a === '-h' || a === '--version')
dropInheritedDevInstanceEnv(process.env, repoRoot)

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
    // Seed stable per-worktree identity for window/Dock/automation labels without Git calls from Electron.
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
  // v11 stabilizes Info.plist/cdhash; ignored stale marker fields permit schema narrowing without another bump.
  const bundleLayoutVersion = 'stable-cdhash-dock-name-from-bundle-dir-v11'
  const hash = createHash('sha1')
    .update(
      `${sourceAppPath}\0${electronVersion ?? ''}\0${title}\0${identityKey}\0${bundleLayoutVersion}`
    )
    .digest('hex')
    .slice(0, 12)
  const distDir = path.join(repoRoot, 'out', 'electron-dev', hash)
  // Dock uses .app directory display name outside code signature, preserving per-branch label without varying cdhash.
  const appBundleName = `${sanitizeMacAppBundleName(title)}.app`
  const appPath = path.join(distDir, appBundleName)
  const markerPath = path.join(distDir, DEV_BUNDLE_MARKER_FILENAME)
  // Use one dev bundle ID for shared notification permission/settings entry. Concurrent instances may lose clicks routed to other instance; unknown IDs are dropped.
  const bundleId = DEV_BUNDLE_ID
  process.env.ORCA_DEV_MACOS_BUNDLE_ID = bundleId
  // Include patch values in reuse marker; layout version alone can reuse stale app identity.
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
  // Require Chromium resources to avoid blank crash; optional swiftc keyboard helper only degrades keyboard behavior when absent.
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
    path.join(appPath, 'Contents', 'MacOS', 'orca-keyboard-layout'),
    path.join(appPath, 'Contents', 'MacOS', 'orca-process-footprint')
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
    // Interrupted copy may leave marker/executable but omit Chromium resources, causing blank crash.
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

  // Never delete live bundle on unsigned cache miss: re-copy would remove running app mid-session; reuse its current tree.
  const rebuildProcessTable = getDevBundleProcessTable()
  if (
    rebuildProcessTable !== null &&
    isDevBundleInUse(distDir, rebuildProcessTable) &&
    // Reject live-looking broken bundle despite orphan crashpad PID; test required Chromium resources only, not optional swiftc helper, to avoid deleting usable app.
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
  // Clone ~280MB bundle first; only plist/helper/signature bytes vary per branch/version.
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
  // Keep Info.plist values constant: branch-varying sealed bytes change cdhash and trigger Keychain prompts. Put branch label in .app directory name outside signature.
  for (const { key, value } of getDevBundlePlistPatches()) {
    setPlistValue(plistPath, key, value)
  }
  for (const { key, value } of getDevHelperPlistPatches()) {
    setPlistValue(helperPlistPath, key, value)
  }

  // Bundle notification helper with dev signing ID because macOS keys authorization by it; without swiftc use delivery-probe fallback.
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

  buildDevSwiftCliHelpers(path.join(appPath, 'Contents', 'MacOS'))

  // Re-sign after copy/plist edits or macOS rejects notification registration (UNErrorDomain 1); signing failure stays nonfatal for dev.
  let signed = true
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
  } catch (error) {
    signed = false
    console.warn(
      `[orca-dev] ad-hoc codesign failed (dev notifications will not deliver): ${error?.message ?? error}`
    )
  }
  // Write reuse marker only after signing: otherwise unsigned cache permanently loses notifications/stable Keychain identity; retry copying next launch instead.
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

  // Restore flattened relative framework symlinks after copy so Chromium finds canonical bundle resources.
  ensureRelativeSymlink(path.join(versionsPath, 'Current'), 'A')
  for (const entry of ['Electron Framework', 'Resources', 'Libraries', 'Helpers']) {
    ensureRelativeSymlink(path.join(frameworkPath, entry), `Versions/Current/${entry}`)
  }
}

function readGitCommonDir() {
  const value = readGitValue(['rev-parse', '--git-common-dir'])
  return value ? path.resolve(repoRoot, value) : null
}

async function prepareDevProfile({ kind, userDataPath }) {
  if (kind === 'worktree') {
    // Why: storage reclaim uses this marker to delete the profile once its worktree is removed.
    writeWorktreeProfileMarker(userDataPath, {
      repoRoot,
      instanceKey: process.env.ORCA_DEV_INSTANCE_KEY,
      gitCommonDir: readGitCommonDir()
    })
  }
  if (seedProfileRequest === null || profileHasState(userDataPath)) {
    return
  }
  const sourceDir =
    seedProfileRequest === '' || seedProfileRequest === '1'
      ? getDefaultSeedSource()
      : path.resolve(seedProfileRequest)
  try {
    await seedDevProfile({ sourceDir, targetDir: userDataPath })
  } catch (error) {
    console.error(`[orca-dev] Profile seed skipped: ${error.message}`)
  }
}

function prepareDevCliWrapper(userDataPath) {
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

seedDevInstanceIdentityEnv()
const devProfile = resolveDevProfile({
  repoRoot,
  instanceKey: process.env.ORCA_DEV_INSTANCE_KEY,
  mode: requestedProfileMode
})
// Why: Electron main reads this; without it main falls back to the shared orca-dev profile.
process.env.ORCA_DEV_USER_DATA_PATH = devProfile.userDataPath
if (!isHelpOrVersion) {
  await prepareDevProfile(devProfile)
}

if (process.env.ORCA_SKIP_DEV_CLI_PREPARE !== '1') {
  prepareDevCliWrapper(devProfile.userDataPath)
}

if (!useStableElectronName && process.env.ORCA_SKIP_DEV_ELECTRON_APP_PREPARE !== '1') {
  prepareMacDevElectronApp()
}

// Inject fake CLI to test Ctrl+C tree teardown without real electron-vite dependency.
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

function prepareDevWebClient() {
  if (process.env.ORCA_SKIP_DEV_WEB_PREPARE === '1' || isHelpOrVersion) {
    return
  }
  // Start fresh worktree immediately: pairing can use non-browser URLs while optional web bundle is unavailable.
  if (!existsSync(getDevWebClientIndexPath()) && process.env.ORCA_DEV_WEB_PREPARE !== '1') {
    console.error(
      '[orca-dev] Web client bundle missing; skipping pairing web build. Run `pnpm run build:web` or set ORCA_DEV_WEB_PREPARE=1 when you need browser pairing.'
    )
    return
  }
  if (isDevWebClientFresh(repoRoot)) {
    return
  }
  const inputs = captureDevWebClientInputs(repoRoot)
  console.error('[orca-dev] Building web client for pairing in the background...')
  // Pairing reads out/web per request, so a stale bundle must not delay Electron startup.
  // Stage then swap, so an interrupted build never leaves out/web empty.
  const stagingDir = path.join(repoRoot, 'out', '.web-next')
  const build = spawn(
    process.execPath,
    [
      viteCli,
      'build',
      '--config',
      path.join(repoRoot, 'vite.web.config.ts'),
      '--outDir',
      stagingDir,
      '--logLevel',
      'warn'
    ],
    { cwd: repoRoot, stdio: 'inherit', env: withRolldownThreadLimit(process.env) }
  )
  webClientBuild = build
  try {
    os.setPriority(build.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Priority is best effort; the build still runs at normal priority.
  }
  build.once('error', (error) => {
    console.error(`[orca-dev] Web client build failed to start: ${error.message}`)
  })
  build.once('exit', (code, signal) => {
    webClientBuild = null
    if (code !== 0) {
      if (!isShuttingDown) {
        console.error(
          `[orca-dev] Web client build failed (${signal ?? code}); pairing serves the previous bundle`
        )
      }
      return
    }
    try {
      const outDir = path.dirname(getDevWebClientIndexPath())
      rmSync(outDir, { recursive: true, force: true })
      renameSync(stagingDir, outDir)
      recordDevWebClientInputs(repoRoot, inputs)
      console.error('[orca-dev] Web client for pairing is ready')
    } catch (error) {
      console.error(`[orca-dev] Could not install the web client build: ${error.message}`)
    }
  })
}

if (!isHelpOrVersion && process.env.ORCA_DEV_INSTANCE_LABEL) {
  console.error(`[orca-dev] Instance: ${process.env.ORCA_DEV_INSTANCE_LABEL}`)
}
// Log background-launch mode so automation’s focus-preserving behavior is visible.
if (!isHelpOrVersion && process.env.ORCA_BACKGROUND_LAUNCH === '1') {
  console.error('[orca-dev] Background launch: window stays off screen; automate through CDP')
}
let forwardedExtras = []
if (!isHelpOrVersion) {
  const ports = await resolveDevInstancePorts({
    forwardedArgs: forwardedRaw,
    instanceKey: process.env.ORCA_DEV_INSTANCE_KEY || repoRoot
  })
  forwardedExtras = ports.forwardedExtras
  announceDevInstance({ repoRoot, profile: devProfile, ...ports })
}
const forwardedArgs = ['dev', ...forwardedRaw, ...forwardedExtras]
const child = spawn(process.execPath, [electronViteCli, ...forwardedArgs], {
  stdio: 'inherit',
  env: withDevRolldownRuntimeEnv(process.env),
  // Own process group so Ctrl+C terminates electron-vite’s Electron descendants on macOS too.
  detached: process.platform !== 'win32'
})

let webClientBuild = null
let isShuttingDown = false

child.once('spawn', () => {
  if (!isHelpOrVersion) {
    startDevStorageReclaim({ repoRoot })
  }
  prepareDevWebClient()
})

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

  webClientBuild?.kill()
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
  // A half-written out/web must not outlive the session that started it.
  webClientBuild?.kill()

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
