import { join } from 'node:path'
import {
  attachClaudePinnedPtyPersistence,
  createClaudePinnedPtyFilePersistence,
  readClaudePinnedPtyRegistryFile,
  seedPinnedClaudePtysFromPersistence
} from './claude-pinned-pty-registry'

/** Restores which surviving `--account` PTYs run which account, so their labels outlive a restart. */
export async function seedClaudePinnedPtyRegistry(userDataPath: string): Promise<void> {
  const registryPath = join(userDataPath, 'claude-pinned-pane-accounts.json')
  seedPinnedClaudePtysFromPersistence(await readClaudePinnedPtyRegistryFile(registryPath))
  attachClaudePinnedPtyPersistence(createClaudePinnedPtyFilePersistence(registryPath))
}
