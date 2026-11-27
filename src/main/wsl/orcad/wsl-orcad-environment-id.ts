import { wslDistroHolderKey } from '../discovery/wsl-distro-holder-record'

const WSL_ORCAD_ENVIRONMENT_ID_PREFIX = 'wsl:'

/** Every registered WSL host's environment id. */
export function defaultWslOrcadEnvironmentId(distro: string): string {
  return `${WSL_ORCAD_ENVIRONMENT_ID_PREFIX}${wslDistroHolderKey(distro)}`
}

/** Synchronous, for callers that only hold an environment id. */
export function isWslOrcadEnvironmentId(environmentId: string): boolean {
  return environmentId.startsWith(WSL_ORCAD_ENVIRONMENT_ID_PREFIX)
}
