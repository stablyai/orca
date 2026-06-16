import { mergePersistedWindowsPath } from '../pty/windows-environment-path'

export function buildLocalPreflightEnv(): NodeJS.ProcessEnv | undefined {
  if (process.platform !== 'win32') {
    return undefined
  }
  const env = { ...process.env }
  // Why: newly installed CLIs update persisted Windows Path, but the running
  // Electron process keeps its old environment until we merge it explicitly.
  mergePersistedWindowsPath(env)
  return env
}
