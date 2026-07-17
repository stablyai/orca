import { isAbsolute, join } from 'node:path'

const DIRECTORY_NAME = 'ssh-relay-runtime-cache'
const SCHEMA_VERSION = 'v1'

export const SSH_RELAY_ARTIFACT_CACHE_ROOT_NAMESPACE = Object.freeze({
  directoryName: DIRECTORY_NAME,
  schemaVersion: SCHEMA_VERSION
})

export function sshRelayArtifactCacheRoot(userDataPath: string): string {
  if (typeof userDataPath !== 'string' || !isAbsolute(userDataPath)) {
    throw new Error('SSH relay artifact cache user-data path must be absolute')
  }

  // Why: one app-owned versioned root prevents environment overrides and permits future migrations.
  return join(userDataPath, DIRECTORY_NAME, SCHEMA_VERSION)
}
