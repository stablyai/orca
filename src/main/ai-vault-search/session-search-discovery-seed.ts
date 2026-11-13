import type { SessionFileInventory } from '../ai-vault/session-file-inventory'

export async function admitSessionSearchPrimarySeed(
  inventory: SessionFileInventory,
  root: string,
  agent: string,
  admit: ((root: string, agent: string) => Promise<boolean>) | undefined
): Promise<boolean> {
  if (
    inventory.primarySeedWaiting &&
    inventory.seedDelivered &&
    (!admit || (await admit(root, agent)))
  ) {
    await inventory.retryFailures()
    return true
  }
  return false
}
