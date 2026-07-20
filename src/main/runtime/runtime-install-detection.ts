import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { app } from 'electron'
import type {
  RuntimeInstallKind,
  RuntimeRestartKind,
  RuntimeUpdateInfo
} from '../../shared/runtime-types'

// Why: everything the mapping needs is captured in one plain snapshot so the
// core is a pure function testable with fixtures — the caching wrapper is the
// only place that touches electron/process/fs.
export type RuntimeInstallDetectionInput = {
  platform: NodeJS.Platform
  arch: string
  isPackaged: boolean
  execPath: string
  appVersion: string
  // process.env.APPIMAGE — set by the AppImage runtime; its value is the install path.
  appImagePath: string | null
  // True for `orca serve`; false when serving from the full desktop app.
  isServeMode: boolean
  // /proc/self/cgroup contents (linux only); null when unreadable or off-linux.
  cgroupContent: string | null
  // Candidate NSIS install roots gathered from Windows env vars.
  windowsInstallRoots: string[]
  // Result of a single startup package-ownership probe on packaged non-AppImage
  // Linux; null when skipped, failed, or inconclusive.
  linuxPackageOwner: 'linux-deb' | 'linux-rpm' | null
}

// Why: a manual `orca serve` inherits its parent's cgroup, so a user-slice
// service unit is only trusted as systemd when it is actually an orca unit.
const ORCA_SERVICE_PREFIX = 'orca'

export function detectRuntimeInstall(input: RuntimeInstallDetectionInput): RuntimeUpdateInfo {
  const systemd = detectSystemdService(input)
  const installKind = detectInstallKind(input)
  const restartKind = detectRestartKind(input, systemd)

  const updateInfo: RuntimeUpdateInfo = {
    currentVersion: input.appVersion,
    installKind,
    restartKind,
    hostArch: input.arch
  }
  if (installKind === 'linux-appimage' && input.appImagePath) {
    updateInfo.installPath = input.appImagePath
  }
  if (systemd) {
    updateInfo.serviceName = systemd.serviceName
  }
  return updateInfo
}

function detectInstallKind(input: RuntimeInstallDetectionInput): RuntimeInstallKind {
  if (!input.isPackaged) {
    return 'source'
  }
  if (input.platform === 'linux' && input.appImagePath) {
    return 'linux-appimage'
  }
  if (input.platform === 'win32') {
    return isUnderWindowsInstallRoot(input) ? 'windows-installer' : 'unknown'
  }
  if (input.platform === 'darwin') {
    // Why: Homebrew casks also copy into /Applications, so mac-homebrew is not
    // distinguishable at runtime; report the broader mac-app (its guide covers Homebrew).
    return isInsideMacAppBundle(input.execPath) ? 'mac-app' : 'unknown'
  }
  if (input.platform === 'linux') {
    // Non-AppImage packaged Linux: only trust deb/rpm from the startup probe.
    return input.linuxPackageOwner ?? 'unknown'
  }
  return 'unknown'
}

function detectRestartKind(
  input: RuntimeInstallDetectionInput,
  systemd: SystemdService | null
): RuntimeRestartKind {
  if (systemd) {
    return 'systemd'
  }
  // Serving from the full desktop app restarts by relaunching the app; a
  // foreground `orca serve` with no systemd markers is stopped and re-run by hand.
  return input.isServeMode ? 'foreground-serve' : 'desktop'
}

type SystemdService = { serviceName: string }

function detectSystemdService(input: RuntimeInstallDetectionInput): SystemdService | null {
  if (input.platform !== 'linux' || !input.cgroupContent) {
    return null
  }
  for (const line of input.cgroupContent.split('\n')) {
    const service = matchSystemdServiceLine(line)
    if (service) {
      return service
    }
  }
  return null
}

function matchSystemdServiceLine(line: string): SystemdService | null {
  const trimmed = line.trim()
  if (trimmed === '') {
    return null
  }
  // cgroup lines are `hierarchy:controllers:/path`; the path is the final field.
  const path = trimmed.slice(trimmed.lastIndexOf(':') + 1)
  const segments = path.split('/').filter((segment) => segment !== '')
  // The leaf `.service` is this process's unit; ancestors like user@1000.service
  // are session managers, not the served unit.
  let leafService: string | null = null
  for (const segment of segments) {
    if (segment.endsWith('.service')) {
      leafService = segment
    }
  }
  if (!leafService) {
    return null
  }
  if (segments.includes('system.slice')) {
    return { serviceName: leafService }
  }
  // A user-slice unit is only trusted when it is itself an orca unit; a manual
  // `orca serve` inside gnome-terminal-server.service must not map to systemd.
  if (segments.includes('user.slice') && leafService.startsWith(ORCA_SERVICE_PREFIX)) {
    return { serviceName: leafService }
  }
  return null
}

function isUnderWindowsInstallRoot(input: RuntimeInstallDetectionInput): boolean {
  const execPath = normalizeWindowsPath(input.execPath)
  return input.windowsInstallRoots.some((root) => {
    const normalizedRoot = normalizeWindowsPath(root)
    return normalizedRoot !== '' && execPath.startsWith(`${normalizedRoot}\\`)
  })
}

function normalizeWindowsPath(value: string): string {
  // Windows paths are case-insensitive and mix separators; normalize both.
  return value.replace(/\//g, '\\').toLowerCase()
}

function isInsideMacAppBundle(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//.test(execPath)
}

// Why: NSIS installs per-user under %LOCALAPPDATA%\Programs and machine-wide
// under Program Files; execPath sitting below one of these is the installer signal.
export function gatherWindowsInstallRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  if (env.LOCALAPPDATA) {
    roots.push(`${env.LOCALAPPDATA}\\Programs`)
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const value = env[key]
    if (value) {
      roots.push(value)
    }
  }
  return roots
}

function readCgroupContent(platform: NodeJS.Platform): string | null {
  if (platform !== 'linux') {
    return null
  }
  try {
    return readFileSync('/proc/self/cgroup', 'utf-8')
  } catch {
    return null
  }
}

// Why: single best-effort startup probe for the deb-vs-rpm split; any failure
// (tool absent, not owned, timeout) yields null so detection reports `unknown`.
function probeLinuxPackageOwner(
  input: Pick<RuntimeInstallDetectionInput, 'platform' | 'isPackaged' | 'execPath' | 'appImagePath'>
): 'linux-deb' | 'linux-rpm' | null {
  if (input.platform !== 'linux' || !input.isPackaged || input.appImagePath) {
    return null
  }
  if (tryPackageProbe('dpkg', ['-S', input.execPath])) {
    return 'linux-deb'
  }
  if (tryPackageProbe('rpm', ['-qf', input.execPath])) {
    return 'linux-rpm'
  }
  return null
}

function tryPackageProbe(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

let cachedUpdateInfo: RuntimeUpdateInfo | undefined

// Gathers real values once and caches the result. Never runs a subprocess or
// reads /proc on the status hot path — status.get reuses the cached snapshot.
export function getRuntimeUpdateInfo(): RuntimeUpdateInfo {
  if (cachedUpdateInfo) {
    return cachedUpdateInfo
  }
  const platform = process.platform
  const isPackaged = app.isPackaged
  const execPath = process.execPath
  const appImagePath = process.env.APPIMAGE ?? null
  cachedUpdateInfo = detectRuntimeInstall({
    platform,
    arch: process.arch,
    isPackaged,
    execPath,
    appVersion: app.getVersion(),
    appImagePath,
    isServeMode: process.argv.includes('--serve'),
    cgroupContent: readCgroupContent(platform),
    windowsInstallRoots: platform === 'win32' ? gatherWindowsInstallRoots(process.env) : [],
    linuxPackageOwner: probeLinuxPackageOwner({ platform, isPackaged, execPath, appImagePath })
  })
  return cachedUpdateInfo
}
