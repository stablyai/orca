import { join } from 'node:path'
import type { Store } from '../persistence'
import {
  attachClaudePinnedPtyPersistence,
  createClaudePinnedPtyFilePersistence,
  readClaudePinnedPtyRegistryFile,
  seedPinnedClaudePtysFromPersistence
} from './claude-pinned-pty-registry'
import {
  attachClaudeHostPtyAccountPersistence,
  createClaudeHostPtyAccountFilePersistence,
  readClaudeHostPtyAccountsFile,
  seedHostClaudePtyAccounts,
  setClaudeActiveHostAccountResolver
} from './claude-host-pty-accounts'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

export function seedClaudePtyAccountRegistries(
  store: Pick<Store, 'getSettings'>,
  persistedClaudePtyIds: string[],
  userDataPath: string
): void {
  // Why: `--account` must not pin an account a surviving host Claude still refreshes.
  setClaudeActiveHostAccountResolver(() =>
    getSelectedClaudeAccountIdForTarget(store.getSettings(), { runtime: 'host' })
  )
  const hostClaudePtyAccountsPath = join(userDataPath, 'claude-host-pane-accounts.json')
  attachClaudeHostPtyAccountPersistence(
    createClaudeHostPtyAccountFilePersistence(hostClaudePtyAccountsPath)
  )
  seedHostClaudePtyAccounts(
    persistedClaudePtyIds,
    readClaudeHostPtyAccountsFile(hostClaudePtyAccountsPath)
  )
  // Why: same restart hazard for `--account` PTYs, whose accounts the global gate never covers.
  const pinnedClaudePtyRegistryPath = join(userDataPath, 'claude-pinned-pane-accounts.json')
  seedPinnedClaudePtysFromPersistence(readClaudePinnedPtyRegistryFile(pinnedClaudePtyRegistryPath))
  attachClaudePinnedPtyPersistence(
    createClaudePinnedPtyFilePersistence(pinnedClaudePtyRegistryPath)
  )
}
