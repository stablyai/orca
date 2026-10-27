import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { toComparableRelaySshPtyId, toRelaySshPtyId } from '../../providers/ssh-pty-id'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

import type { StoreRuntimeState } from './store-runtime-state'

type TerminalBindingRecoveryOperationsRuntime = Pick<StoreRuntimeState, 'state'>

/** Expired means lost route, not exit: retain binding for reattach. Only terminated withdraws it. */
function sshRemotePtyLeaseWithdrawsBinding(lease: SshRemotePtyLease): boolean {
  return lease.state === 'terminated'
}

export class TerminalBindingRecoveryOperations {
  constructor(private readonly runtime: TerminalBindingRecoveryOperationsRuntime) {}

  getTerminalLayoutLeafIds(root: TerminalPaneLayoutNode | null): Set<string> {
    const leafIds = new Set<string>()
    const visit = (node: TerminalPaneLayoutNode | null): void => {
      if (!node) {
        return
      }
      if (node.type === 'leaf') {
        if (isTerminalLeafId(node.leafId)) {
          leafIds.add(node.leafId)
        }
        return
      }
      visit(node.first)
      visit(node.second)
    }
    visit(root)
    return leafIds
  }

  isRestorablePtyBinding(binding: {
    ptyId: string
    targetId?: string | null
    worktreeId?: string
    tabId?: string
    leafId?: string
  }): boolean {
    const leases = this.runtime.state.sshRemotePtyLeases?.filter((entry) =>
      this.sshRemotePtyLeaseMatchesBinding(entry, binding)
    )
    return !leases?.some(sshRemotePtyLeaseWithdrawsBinding)
  }

  getRelayPtyIdForSshLeaseComparison(targetId: string, ptyId: string): string {
    return toComparableRelaySshPtyId(targetId, ptyId)
  }

  getRelayPtyIdForSshLeaseStorage(targetId: string, ptyId: string): string {
    return toRelaySshPtyId(targetId, ptyId)
  }

  sshRemotePtyLeaseMatchesBinding(
    lease: SshRemotePtyLease,
    binding: {
      ptyId: string
      targetId?: string | null
      worktreeId?: string
      tabId?: string
      leafId?: string
    }
  ): boolean {
    const bindingPtyId = this.getRelayPtyIdForSshLeaseComparison(lease.targetId, binding.ptyId)
    if (lease.ptyId !== bindingPtyId) {
      return false
    }
    // Relay-local PTY IDs require matching target context to avoid retiring unrelated panes.
    return (
      (binding.targetId === undefined ||
        binding.targetId === null ||
        lease.targetId === binding.targetId) &&
      (binding.worktreeId === undefined || lease.worktreeId === binding.worktreeId) &&
      (binding.tabId === undefined || lease.tabId === binding.tabId) &&
      (binding.leafId === undefined || lease.leafId === binding.leafId)
    )
  }

  hasRestorableSshRemotePtyLease(binding: {
    ptyId: string
    targetId?: string | null
    worktreeId?: string
    tabId?: string
    leafId?: string
  }): boolean {
    return (
      this.runtime.state.sshRemotePtyLeases?.some(
        (lease) =>
          this.sshRemotePtyLeaseMatchesBinding(lease, binding) &&
          !sshRemotePtyLeaseWithdrawsBinding(lease)
      ) ?? false
    )
  }

  getConnectionIdForWorktree(worktreeId: string): string | null {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return this.runtime.state.repos.find((repo) => repo.id === repoId)?.connectionId ?? null
  }
}
