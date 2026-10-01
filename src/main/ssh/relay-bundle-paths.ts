import { join } from 'node:path'
import type { RelayPlatform } from './relay-protocol'

export function relayBundleCandidates(platform: RelayPlatform, appPath: string): string[] {
  return [
    ...new Set([
      ...(process.env.ORCA_RELAY_PATH ? [join(process.env.ORCA_RELAY_PATH, platform)] : []),
      ...(process.resourcesPath
        ? [
            join(process.resourcesPath, 'relay', platform),
            join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', platform)
          ]
        : []),
      join(appPath, 'resources', 'relay', platform),
      join(appPath, 'out', 'relay', platform)
    ])
  ]
}
