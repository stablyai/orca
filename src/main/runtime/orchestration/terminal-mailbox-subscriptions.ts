import type { OrchestrationMailboxPointerSubmitTarget } from './mailbox-pointer-submit'
import type {
  TerminalMailboxSubscriptionState,
  TerminalMailboxSubscriptionStatus,
  TerminalMailboxWake
} from '../../../shared/terminal-mailbox-subscription'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime-terminal-contracts'

export function isTerminalMailbox(handle: string): boolean {
  return /^term_[a-zA-Z0-9_-]+$/.test(handle)
}

type Subscription = {
  generation: number
  binding: TerminalMailboxSubscriptionBinding
  status: TerminalMailboxSubscriptionStatus
}

type InactiveSubscription = {
  binding?: TerminalMailboxSubscriptionBinding
  status: TerminalMailboxSubscriptionStatus
}

export type TerminalMailboxSubscriptionBinding = Readonly<{
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope']
  terminalHandle: string
  paneKey: string
  ptyId: string
  processIncarnation: string
  createdAt: string
}>

export type CurrentTerminalMailboxAuthority = Omit<TerminalMailboxSubscriptionBinding, 'createdAt'>

function hostScopesEqual(
  left: TerminalMailboxSubscriptionBinding['hostScope'],
  right: TerminalMailboxSubscriptionBinding['hostScope']
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Registrations belong to this runtime; no authority is restored after restart. */
export class TerminalMailboxSubscriptions {
  private nextGeneration = 0
  private readonly entries = new Map<string, Subscription>()
  private readonly inactive = new Map<string, InactiveSubscription>()

  constructor(
    private readonly resolveCurrent: (
      handle: string
    ) => CurrentTerminalMailboxAuthority | null = () => null
  ) {}

  register(
    target: OrchestrationMailboxPointerSubmitTarget,
    binding: TerminalMailboxSubscriptionBinding
  ): void {
    const handle = target.terminalHandle
    const existing = this.entries.get(handle)
    if (existing && this.bindingsEqual(existing.binding, binding) && this.matches(handle, target)) {
      return
    }
    this.inactive.delete(handle)
    this.entries.set(handle, {
      generation: ++this.nextGeneration,
      binding,
      status: {
        subscribed: true,
        state: 'active',
        wake: 'deferred',
        reason: 'awaiting_mail_or_idle',
        messageIds: [],
        createdAt: binding.createdAt,
        submitPolicy: 'recognized_non_cursor'
      }
    })
  }

  generation(handle: string): number | undefined {
    return this.entries.get(handle)?.generation
  }

  retirePty(ptyId: string): void {
    for (const [handle, entry] of this.entries) {
      if (entry.binding.ptyId === ptyId) {
        this.deactivate(handle, entry, 'proven_exited', 'pty_proven_exited')
      }
    }
  }

  remove(handle: string): void {
    const entry = this.entries.get(handle)
    if (entry) {
      this.deactivate(handle, entry, 'unsubscribed', 'explicit_unsubscribe')
    } else {
      const inactive = this.inactive.get(handle)
      if (inactive?.status.state === 'unsubscribed') {
        return
      }
      this.inactive.set(handle, {
        binding: inactive?.binding,
        status: inactive
          ? {
              ...inactive.status,
              subscribed: false,
              state: 'unsubscribed',
              wake: 'unsupported',
              reason: 'explicit_unsubscribe'
            }
          : this.inactiveStatus('unsubscribed', 'explicit_unsubscribe')
      })
    }
  }

  canManage(handle: string, current: CurrentTerminalMailboxAuthority): boolean {
    const binding = this.entries.get(handle)?.binding ?? this.inactive.get(handle)?.binding
    return binding === undefined || this.currentMatchesBinding(current, binding)
  }

  matches(handle: string, target: OrchestrationMailboxPointerSubmitTarget): boolean {
    const entry = this.entries.get(handle)
    if (!entry) {
      return false
    }
    if (!this.targetMatchesBinding(target, entry.binding)) {
      this.deactivate(handle, entry, 'stale_replaced', 'target_identity_changed')
      return false
    }
    return this.refreshCurrent(handle, entry)
  }

  record(
    handle: string,
    state: TerminalMailboxSubscriptionState,
    wake: TerminalMailboxWake,
    reason: string,
    messageIds: string[],
    generation: number | undefined
  ): void {
    const entry = this.entries.get(handle)
    if (entry && generation !== undefined && entry.generation === generation) {
      entry.status = {
        ...entry.status,
        subscribed: true,
        state,
        wake,
        reason,
        messageIds: [...messageIds]
      }
    }
  }

  status(handle: string): TerminalMailboxSubscriptionStatus {
    const entry = this.entries.get(handle)
    if (entry) {
      this.refreshCurrent(handle, entry)
    }
    const current = this.entries.get(handle)
    if (current) {
      return { ...current.status, messageIds: [...current.status.messageIds] }
    }
    const inactive = this.inactive.get(handle)
    return inactive
      ? { ...inactive.status, messageIds: [...inactive.status.messageIds] }
      : this.inactiveStatus('unsubscribed', 'not_subscribed')
  }

  private bindingsEqual(
    left: TerminalMailboxSubscriptionBinding,
    right: TerminalMailboxSubscriptionBinding
  ): boolean {
    return (
      left.terminalHandle === right.terminalHandle &&
      left.paneKey === right.paneKey &&
      left.ptyId === right.ptyId &&
      left.processIncarnation === right.processIncarnation &&
      hostScopesEqual(left.hostScope, right.hostScope)
    )
  }

  private targetMatchesBinding(
    target: OrchestrationMailboxPointerSubmitTarget,
    binding: TerminalMailboxSubscriptionBinding
  ): boolean {
    return (
      target.terminalHandle === binding.terminalHandle &&
      `${target.leaf.tabId}:${target.leaf.leafId}` === binding.paneKey &&
      target.leaf.ptyId === binding.ptyId &&
      target.processIncarnation === binding.processIncarnation
    )
  }

  private currentMatchesBinding(
    current: CurrentTerminalMailboxAuthority,
    binding: TerminalMailboxSubscriptionBinding
  ): boolean {
    return (
      current.terminalHandle === binding.terminalHandle &&
      current.paneKey === binding.paneKey &&
      current.ptyId === binding.ptyId &&
      current.processIncarnation === binding.processIncarnation &&
      hostScopesEqual(current.hostScope, binding.hostScope)
    )
  }

  private refreshCurrent(handle: string, entry: Subscription): boolean {
    const current = this.resolveCurrent(handle)
    if (!current) {
      entry.status = {
        ...entry.status,
        state: 'host_unverifiable',
        wake: 'unverifiable',
        reason: 'current_authority_unverifiable'
      }
      return false
    }
    if (!this.currentMatchesBinding(current, entry.binding)) {
      this.deactivate(handle, entry, 'stale_replaced', 'current_authority_replaced')
      return false
    }
    if (entry.status.state === 'host_unverifiable') {
      entry.status = {
        ...entry.status,
        state: 'active',
        wake: 'deferred',
        reason: 'current_authority_restored'
      }
    }
    return true
  }

  private deactivate(
    handle: string,
    entry: Subscription,
    state: Extract<
      TerminalMailboxSubscriptionState,
      'stale_replaced' | 'proven_exited' | 'unsubscribed'
    >,
    reason: string
  ): void {
    this.entries.delete(handle)
    this.inactive.set(handle, {
      binding: entry.binding,
      status: {
        ...entry.status,
        subscribed: false,
        state,
        wake: 'unsupported',
        reason
      }
    })
  }

  private inactiveStatus(
    state: Extract<TerminalMailboxSubscriptionState, 'unsubscribed'>,
    reason: string
  ): TerminalMailboxSubscriptionStatus {
    return {
      subscribed: false,
      state,
      wake: 'unsupported',
      reason,
      messageIds: [],
      createdAt: null,
      submitPolicy: 'recognized_non_cursor'
    }
  }
}
