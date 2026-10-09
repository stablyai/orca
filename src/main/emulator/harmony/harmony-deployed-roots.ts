import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'

// Default deployed-instance parent directories used when the Emulator binary
// cannot list instances. HarmonyOS_HVD_HOME overrides; then current and legacy
// default layouts under the user's home directory.
export function defaultDeployedRoots(): string[] {
  const roots: string[] = []
  if (process.env.HarmonyOS_HVD_HOME) {
    roots.push(process.env.HarmonyOS_HVD_HOME)
  }
  roots.push(join(homedir(), '.Huawei', 'Emulator', 'deployed'))
  roots.push(join(homedir(), '.Huawei', 'HarmonyOSEmulator', 'deployed'))
  return roots
}

export function readDeployedDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
