// This app's `orca` CLI by absolute path, as its own terminals get it (orca-cli-child-path.ts), for
// the MCP config entries that run it. Resolved once per data folder: a run's launcher doesn't move.
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { prependOrcaCliDirToChildPath } from './orca-cli-child-path'

const resolved = new Map<string, string | null>()

export function thisAppOrcaCliLauncher(userDataPath: string): string | null {
  if (!resolved.has(userDataPath)) {
    resolved.set(
      userDataPath,
      prependOrcaCliDirToChildPath(
        {},
        {
          isPackaged: getAppEnvironment().isPackaged(),
          userDataPath,
          resourcesPath: process.resourcesPath ?? null
        }
      )
    )
  }
  return resolved.get(userDataPath) ?? null
}
