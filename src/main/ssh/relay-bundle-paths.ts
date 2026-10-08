import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { RelayPlatform } from './relay-protocol'

function currentAppPath(): string | undefined {
  try {
    return getAppEnvironment().getAppPath()
  } catch {
    // Tests, early startup and plain-Node hosts have no app path; env/resources candidates suffice.
    return undefined
  }
}

/** `wsl` is the WSL-only guest bundle dir (`out/relay/wsl`), never uploaded to SSH hosts. */
export function relayBundleCandidates(
  platform: RelayPlatform | 'wsl',
  appPath = currentAppPath()
): string[] {
  return [
    ...new Set([
      ...(process.env.ORCA_RELAY_PATH ? [join(process.env.ORCA_RELAY_PATH, platform)] : []),
      ...(process.resourcesPath
        ? [
            join(process.resourcesPath, 'relay', platform),
            join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', platform)
          ]
        : []),
      ...(appPath
        ? [join(appPath, 'resources', 'relay', platform), join(appPath, 'out', 'relay', platform)]
        : [])
    ])
  ]
}
