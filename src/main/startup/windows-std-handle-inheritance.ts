import { loadWindowsSecurity } from '../../shared/windows-security-addon'

/** libuv spawns with bInheritHandles=TRUE, so an inheritable std handle reaches every child, and a
 * long-lived one (the WSL holder, the daemon) keeps a launcher's pipe open after Orca exits. */
export function clearWindowsStdHandleInheritance(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    return
  }
  try {
    const security = loadWindowsSecurity()
    if ('error' in security) {
      console.warn(`[startup] std handles stay inheritable; addon unavailable: ${security.error}`)
      return
    }
    for (const failure of security.addon.clearStdHandleInheritance()) {
      console.warn(`[startup] ${failure.stream} stays inheritable; Win32 error ${failure.code}`)
    }
  } catch (error) {
    console.warn('[startup] std handles stay inheritable:', error)
  }
}
