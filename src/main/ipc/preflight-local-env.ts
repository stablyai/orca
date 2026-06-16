import { mergePersistedWindowsPath } from '../pty/windows-environment-path'

function stringOnlyProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function buildLocalPreflightEnv(): Record<string, string> | undefined {
  if (process.platform !== 'win32') {
    return undefined
  }
  const env = stringOnlyProcessEnv(process.env)
  // Why: newly installed CLIs update persisted Windows Path, but the running
  // Electron process keeps its old environment until we merge it explicitly.
  mergePersistedWindowsPath(env)
  return env
}
