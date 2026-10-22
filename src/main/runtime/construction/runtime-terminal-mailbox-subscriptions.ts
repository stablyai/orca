import { OrcaRuntimeWithRuntimeId } from './runtime-identity-state'
import {
  TerminalMailboxSubscriptions,
  type CurrentTerminalMailboxAuthority
} from '../orchestration/terminal-mailbox-subscriptions'
import { resolveTerminalMailboxSubscriptionLeaf } from '../orchestration/terminal-mailbox-subscription-target'
import { orchestrationCompatibilityHostScopesEqual } from '../orchestration-compatibility-host-scope'
import type { OrchestrationCompatibilityEvidence } from '../../../shared/orchestration-compatibility-evidence'
import type { OrchestrationCompatibilityCallerAuthority } from '../runtime-terminal-contracts'
import type { OrchestrationMailboxOwner } from '../orchestration/mailbox-owner'

export abstract class OrcaRuntimeWithTerminalMailboxSubscriptions extends OrcaRuntimeWithRuntimeId {
  protected abstract readonly orchestrationMailboxOwner: OrchestrationMailboxOwner

  abstract verifyOrchestrationCompatibilityCaller(
    evidence: OrchestrationCompatibilityEvidence | null | undefined,
    options?: { currentRuntimeLaunchSufficient?: boolean }
  ): OrchestrationCompatibilityCallerAuthority | null

  protected readonly terminalMailboxSubscriptions = new TerminalMailboxSubscriptions((handle) =>
    this.currentTerminalMailboxAuthority(handle)
  )

  private currentTerminalMailboxAuthority(handle: string): CurrentTerminalMailboxAuthority | null {
    const current = this.getOrchestrationDispatchAuthority(handle)
    return current?.paneKey && current.processIncarnation
      ? {
          hostScope: current.hostScope,
          terminalHandle: current.terminalHandle,
          paneKey: current.paneKey,
          ptyId: current.ptyId,
          processIncarnation: current.processIncarnation
        }
      : null
  }

  getTerminalMailboxSubscriptionBinding(
    evidence: OrchestrationCompatibilityEvidence | undefined
  ): CurrentTerminalMailboxAuthority {
    const authority = this.verifyOrchestrationCompatibilityCaller(evidence, {
      currentRuntimeLaunchSufficient: true
    })
    if (!authority) {
      throw new Error('A verified current terminal launch is required for mailbox subscription.')
    }
    const current = this.getOrchestrationDispatchAuthority(authority.terminalHandle)
    if (
      !current?.paneKey ||
      !current.processIncarnation ||
      current.paneKey !== authority.paneKey ||
      current.processIncarnation !== authority.processIncarnation ||
      !orchestrationCompatibilityHostScopesEqual(current.hostScope, authority.hostScope)
    ) {
      throw new Error('The attested terminal identity changed before mailbox subscription access.')
    }
    return {
      hostScope: current.hostScope,
      terminalHandle: authority.terminalHandle,
      paneKey: current.paneKey,
      ptyId: current.ptyId,
      processIncarnation: current.processIncarnation
    }
  }

  protected resolveTerminalMailboxSubscriptionTarget(
    handle: string,
    binding = this.terminalMailboxSubscriptions.binding(handle)
  ) {
    if (!binding) {
      return null
    }
    const leaf = resolveTerminalMailboxSubscriptionLeaf({
      binding,
      current: this.currentTerminalMailboxAuthority(handle),
      ptys: this.ptysById.values(),
      leaves: this.leaves.values(),
      handleForPty: (ptyId) => this.handleByPtyId.get(ptyId),
      handleForLeaf: (tabId, leafId) => this.handleByLeafKey.get(this.getLeafKey(tabId, leafId))
    })
    return leaf?.ptyId ? this.resolveOrchestrationPointerSubmitTarget(leaf, leaf.ptyId) : null
  }

  terminalMailboxSubscription(
    action: 'subscribe' | 'unsubscribe' | 'status',
    evidence: OrchestrationCompatibilityEvidence | undefined
  ) {
    const currentBinding = this.getTerminalMailboxSubscriptionBinding(evidence)
    const handle = currentBinding.terminalHandle
    if (
      action !== 'subscribe' &&
      !this.terminalMailboxSubscriptions.canManage(handle, currentBinding)
    ) {
      throw new Error('Mailbox subscription state belongs to a different terminal identity.')
    }
    if (action === 'unsubscribe') {
      this.terminalMailboxSubscriptions.remove(handle)
    }
    if (action === 'subscribe') {
      const target = this.resolveTerminalMailboxSubscriptionTarget(handle, currentBinding)
      if (target && target.leaf.ptyId !== currentBinding.ptyId) {
        throw new Error('The attested terminal identity changed before subscription registration.')
      }
      if (
        !target ||
        this.orchestrationMailboxOwner.resolve(target.leaf, undefined, {
          terminalHandle: handle
        }) !== handle
      ) {
        throw new Error('Mailbox subscriptions require a live bare terminal mailbox.')
      }
      this.terminalMailboxSubscriptions.register(target, {
        ...currentBinding,
        createdAt: new Date().toISOString()
      })
      this.deliverPendingMessagesForHandle(handle)
    }
    return this.terminalMailboxSubscriptions.status(handle)
  }
}
