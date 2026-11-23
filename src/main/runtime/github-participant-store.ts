import { GitHubParticipantRegistry } from './github-participant-registry'

type ParticipantStore = { getProfileStorageDirectory?: () => string }
export type GitHubParticipantDeviceLookup = (deviceId: string) => { parentDeviceId?: string } | null

type RegistryEntry = {
  registry: GitHubParticipantRegistry
  lookupDevice: GitHubParticipantDeviceLookup
}

const registries = new WeakMap<ParticipantStore, RegistryEntry>()

export function getStoreGitHubParticipants(
  store: ParticipantStore
): GitHubParticipantRegistry | undefined {
  const existing = registries.get(store)
  if (existing) {
    return existing.registry
  }
  const directory = store.getProfileStorageDirectory?.()
  if (!directory) {
    return undefined
  }
  const entry: RegistryEntry = {
    registry: new GitHubParticipantRegistry(directory, (id) => entry.lookupDevice(id)),
    lookupDevice: () => null
  }
  registries.set(store, entry)
  return entry.registry
}

export function configureStoreGitHubParticipantDevices(
  store: ParticipantStore,
  lookupDevice: GitHubParticipantDeviceLookup
): void {
  getStoreGitHubParticipants(store)
  const entry = registries.get(store)
  if (entry) {
    entry.lookupDevice = lookupDevice
  }
}
