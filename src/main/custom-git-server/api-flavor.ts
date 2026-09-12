import type { CustomGitServerApiFlavor } from '../../shared/custom-git-server'
import type { CustomGitServerFlavorClient } from './api-flavor-client'
import { gitlabCompatFlavorClient } from './gitlab-compat-client'

// The registry of API-flavor clients. To support a new custom-server API, add a
// value to CustomGitServerApiFlavor, implement CustomGitServerFlavorClient, and
// register it here — nothing else in the provider/persistence/UI plumbing changes.
const FLAVOR_CLIENTS: Record<CustomGitServerApiFlavor, CustomGitServerFlavorClient> = {
  gitlab: gitlabCompatFlavorClient
}

/** The registered API client for a server's flavor. */
export function getCustomGitServerFlavorClient(
  flavor: CustomGitServerApiFlavor
): CustomGitServerFlavorClient {
  return FLAVOR_CLIENTS[flavor]
}
