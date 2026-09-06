import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { toComparableRelaySshPtyId, toRelaySshPtyId } from '../../providers/ssh-pty-id'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

import type { StoreRuntimeState } from './store-runtime-state'

type TerminalBindingRecoveryOperationsRuntime = Pick<StoreRuntimeState, 'state'>

/**
 * `terminated` is the only lease state that withdraws a pane binding. It is the operator-close
 * state, and the one written after a host-acknowledged stop.
 *
 * `expired` is deliberately not death: every writer of it records that the CLIENT lost its route —
 * a superseded sibling, a recycled relay id, a persistPtyBinding refusal, a failed reattach, a
 * relay reset — and `docs/reference/ssh-execution-boundary.md` grades all of those `unverifiable`.
 * Refusing the binding there strands a remote shell that is still running behind a pane that can no
 * longer reach it. Keeping it authorizes a reattach ATTEMPT, never a respawn: when the shell really
 * is gone, `attachStablePaneOwner` retires the binding on the relay's own absence answer and falls
 * through to a fresh spawn.
 */
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
    // Why: remote PTY ids are scoped to a relay target; require stored lease context to match so missing fields don't tombstone unrelated panes.
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
