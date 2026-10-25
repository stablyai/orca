import { mergePersistedWindowsPath } from '../pty/windows-environment-path'
import {
  readGuestWindowsDriveMounts,
  withoutWindowsDriveMountDirs
} from './wsl-guest-windows-drive-path'

function stringOnlyProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function buildLocalPreflightEnv(
  guestWindowsDriveMounts: readonly string[] = readGuestWindowsDriveMounts()
): Record<string, string> | undefined {
  if (process.platform !== 'win32') {
    if (guestWindowsDriveMounts.length === 0) {
      return undefined
    }
    // In a WSL guest, detection must find the Linux CLI, not a Windows shim on /mnt/<drive>.
    const env = stringOnlyProcessEnv(process.env)
    env.PATH = withoutWindowsDriveMountDirs(env.PATH ?? '', guestWindowsDriveMounts)
    return env
  }
  const env = stringOnlyProcessEnv(process.env)
  // The running app must merge persisted Windows PATH to see newly installed CLIs.
  mergePersistedWindowsPath(env)
  return env
}
