import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

/** The WSL-only guest bundle dir (`out/relay/wsl`): never uploaded to SSH hosts. Mirrors
 *  getLocalRelayCandidates in ssh-relay-deploy: env override, packaged resources, then dev out/. */
export function wslRelayBundleDirs(): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_RELAY_PATH) {
    candidates.push(join(process.env.ORCA_RELAY_PATH, 'wsl'))
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'relay', 'wsl'))
    candidates.push(join(process.resourcesPath, 'app.asar.unpacked', 'out', 'relay', 'wsl'))
  }
  try {
    const appPath = getAppEnvironment().getAppPath()
    candidates.push(join(appPath, 'resources', 'relay', 'wsl'))
    candidates.push(join(appPath, 'out', 'relay', 'wsl'))
  } catch {
    // Tests, early startup and plain-Node hosts have no app path; env/resources candidates suffice.
  }
  return candidates
}
