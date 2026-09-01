// Decision spec for Windows NSIS upgrade hooks. Keep in sync with upgrade-install-state.nsh.

const UNEXPANDED_NSIS = /\$[A-Za-z_{]/

export function normalizeWindowsPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
}

export function isUnexpandedNsisValue(value) {
  return UNEXPANDED_NSIS.test(String(value ?? ''))
}

export function isTooBroadInstallLocation(value) {
  const normalized = normalizeWindowsPath(value).toLowerCase()
  if (!normalized) {
    return true
  }
  if (/^[a-z]:$/.test(normalized)) {
    return true
  }
  const parts = normalized.split('\\').filter(Boolean)
  if (parts.length <= 1) {
    return true
  }
  if (parts.length === 2 && parts[1] === 'users') {
    return true
  }
  if (parts.length === 3 && parts[1] === 'users') {
    return true
  }
  return (
    normalized.endsWith('\\appdata') ||
    normalized.endsWith('\\appdata\\local') ||
    normalized.endsWith('\\appdata\\roaming') ||
    normalized.endsWith('\\appdata\\local\\orca') ||
    normalized.endsWith('\\appdata\\roaming\\orca')
  )
}

export function sanitizeInstallLocation(value) {
  const raw = String(value ?? '').trim()
  if (!raw || isUnexpandedNsisValue(raw)) {
    return null
  }
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) {
    return null
  }
  if (isTooBroadInstallLocation(raw)) {
    return null
  }
  return normalizeWindowsPath(raw)
}

export function parseUninstallExecutable(uninstallString) {
  const quoted = String(uninstallString ?? '').match(/"([^"]+\.exe)"/i)
  if (quoted?.[1]) {
    return quoted[1]
  }
  const unquoted = String(uninstallString ?? '').trim().match(/^([^"]+\.exe)\b/i)
  return unquoted?.[1] ?? null
}

export function parentDirectory(filePath) {
  const normalized = normalizeWindowsPath(filePath)
  const slash = normalized.lastIndexOf('\\')
  return slash > 0 ? normalized.slice(0, slash) : null
}

/**
 * @param {object} input
 * @param {string | null | undefined} input.installLocation registry InstallLocation
 * @param {string | null | undefined} input.uninstallString registry UninstallString
 * @param {string} input.defaultInstallDir per-user Programs\Orca default
 * @param {string | null | undefined} input.commandLineInstallDir NSIS /D= override
 * @param {(dir: string) => boolean} [input.pathHasAppExecutable]
 * @param {(exe: string) => boolean} [input.uninstallExecutableExists]
 */
export function resolveNsisUpgradeState({
  installLocation,
  uninstallString,
  defaultInstallDir,
  commandLineInstallDir,
  pathHasAppExecutable = () => false,
  uninstallExecutableExists = () => false
}) {
  const defaultDir = normalizeWindowsPath(defaultInstallDir)
  const fromCommandLine = sanitizeInstallLocation(commandLineInstallDir)
  const uninstallExe = parseUninstallExecutable(uninstallString)
  const uninstallExeUsable =
    Boolean(uninstallExe) &&
    !isUnexpandedNsisValue(uninstallExe) &&
    uninstallExecutableExists(uninstallExe)
  const fromUninstaller = uninstallExeUsable
    ? sanitizeInstallLocation(parentDirectory(uninstallExe))
    : null
  const fromRegistry = registryInstallDir(installLocation, pathHasAppExecutable, fromUninstaller)

  const instDir = fromCommandLine || fromRegistry || fromUninstaller || defaultDir
  const runPreviousUninstaller = uninstallExeUsable && Boolean(fromUninstaller)
  const discardUninstallString = Boolean(uninstallString) && !runPreviousUninstaller
  // uninstallOldVersion passes InstallLocation to _?= unquoted. Never persist /D=.
  const previousLocation = sanitizeInstallLocation(installLocation)
  let installLocationToWrite = null
  if (fromUninstaller) {
    if (previousLocation !== fromUninstaller) {
      installLocationToWrite = fromUninstaller
    }
  } else if (!previousLocation && !fromCommandLine) {
    installLocationToWrite = instDir
  }
  const repairInstallLocation = Boolean(installLocationToWrite)

  return {
    instDir,
    runPreviousUninstaller,
    repairInstallLocation,
    installLocationToWrite,
    discardUninstallString,
    recoveredFromUninstaller: !fromCommandLine && !fromRegistry && Boolean(fromUninstaller)
  }
}

function registryInstallDir(value, pathHasAppExecutable, uninstallParent) {
  const sanitized = sanitizeInstallLocation(value)
  if (!sanitized) {
    return null
  }
  if (pathHasAppExecutable(sanitized) || sanitized === uninstallParent) {
    return sanitized
  }
  return null
}

export function isCloseAppProcess({ processPath, instDir, imageName }) {
  const location = sanitizeInstallLocation(instDir)
  const pathValue = normalizeWindowsPath(processPath)
  if (!location || !pathValue) {
    return false
  }
  const prefix = `${location.toLowerCase()}\\`
  if (!pathValue.toLowerCase().startsWith(prefix)) {
    return false
  }
  const base = (imageName || pathValue.split('\\').pop() || '').toLowerCase()
  if (base === 'orca-terminal-daemon.exe') {
    return false
  }
  return base === 'orca.exe'
}

export function shouldReportAppCannotBeClosed({ remainingProcessPaths, instDir }) {
  const location = sanitizeInstallLocation(instDir)
  if (!location) {
    return false
  }
  const mainExe = `${location}\\Orca.exe`.toLowerCase()
  return (remainingProcessPaths ?? []).some(
    (processPath) => normalizeWindowsPath(processPath).toLowerCase() === mainExe
  )
}

export function mapPreviousUninstallerOutcome({ ran, exitCode, uninstallStringUsable }) {
  if (!ran || !uninstallStringUsable) {
    return { abortInstaller: false, reportCannotBeClosed: false }
  }
  if (exitCode === 0) {
    return { abortInstaller: false, reportCannotBeClosed: false }
  }
  // A failed old uninstaller is not proof the app is running.
  return { abortInstaller: false, reportCannotBeClosed: false }
}
