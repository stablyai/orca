import {
  createdWorktreeAccountPinPatch,
  type WorktreeAccountPins,
  type WorktreeAccountPinSettings
} from '../../../shared/worktree-account-pin-settings'

// Both the IPC Store and the runtime's RuntimeStore fit this.
type PinStore = {
  getSettings(): Parameters<typeof createdWorktreeAccountPinPatch>[0]
  updateSettings?: (
    updates: WorktreeAccountPinSettings,
    options?: { notifyListeners?: boolean }
  ) => unknown
}

/**
 * Worker accounts (#9496): pin a just-created worktree to the accounts chosen in the create
 * dialog. Called when the worktree is registered, before its startup agent launches, so the
 * agent's first session already runs on that account.
 */
export function pinCreatedWorktreeAccounts(
  store: PinStore,
  worktreeId: string,
  pins: WorktreeAccountPins | undefined
): void {
  const patch = pins && createdWorktreeAccountPinPatch(store.getSettings(), worktreeId, pins)
  if (patch) {
    store.updateSettings?.(patch, { notifyListeners: true })
  }
}
