// Bridges pending profile launches to the existing durable pane-account registry.
import type { CodexPaneAccountRegistryFile } from './codex-pane-account-registry-types'
export function createCodexProfileAccountOwners(read: () => CodexPaneAccountRegistryFile) {
  const pending = new Map<symbol, string>()
  return {
    reserve(accountId: string): () => void {
      const lease = Symbol('pending Codex profile launch')
      pending.set(lease, accountId)
      return () => {
        pending.delete(lease)
      }
    },
    has(accountId: string): boolean {
      return (
        [...pending.values()].includes(accountId) ||
        Object.values(read().panes).some(
          (record) => record.profileBound === true && record.accountId === accountId
        )
      )
    }
  }
}
