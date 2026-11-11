import { join, win32 } from 'node:path'

export const WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME = 'orca-agent-hook.exe'

export function getWindowsNativeHookAgent(scriptPath: string): string {
  // win32: these are Windows paths even when the code runs (or is tested) on another host.
  return win32.basename(scriptPath).replace(/-hook(?:\.(?:cmd|ps1|sh))?$/, '')
}

/** CLI hosts have no bundled binary; dev paths may resolve without a file, so installers check existence. */
export function resolveBundledWindowsNativeHookExecutable(): string | null {
  // CLI builds lack the Electron Process type.
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  return process.platform === 'win32' && typeof resourcesPath === 'string' && resourcesPath
    ? join(resourcesPath, 'bin', WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME)
    : null
}
