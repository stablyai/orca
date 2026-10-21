import { join, win32 } from 'node:path'

/** The packaged binary (native/windows-agent-hook), installed under the same name. */
export const WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME = 'orca-agent-hook.exe'

/** The agent argument the exe takes for a managed script: `…\claude-hook.cmd` → `claude`. */
export function getWindowsNativeHookAgent(scriptPath: string): string {
  // win32: these are Windows paths even when the code runs (or is tested) on another host.
  return win32.basename(scriptPath).replace(/-hook(?:\.(?:cmd|ps1|sh))?$/, '')
}

/**
 * Where this app ships the hook binary, or null off Windows and in orcad. Dev checkouts resolve
 * a path with no file there, so their install places no new copy.
 */
export function resolveBundledWindowsNativeHookExecutable(): string | null {
  // Narrowed rather than typed: the CLI build compiles this without Electron's Process type.
  const resourcesPath = 'resourcesPath' in process ? process.resourcesPath : undefined
  return process.platform === 'win32' && typeof resourcesPath === 'string' && resourcesPath
    ? join(resourcesPath, 'bin', WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME)
    : null
}
