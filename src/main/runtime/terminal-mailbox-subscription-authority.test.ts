import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithStopRequestedPtyIds } from './orca-runtime-stop-requested-pty-ids'
import { OrcaRuntimeService } from './orca-runtime'
import {
  TerminalMailboxSubscriptions,
  type TerminalMailboxSubscriptionBinding
} from './orchestration/terminal-mailbox-subscriptions'

const method = OrcaRuntimeWithStopRequestedPtyIds.prototype.terminalMailboxSubscription
function fixture() {
  const leaf = {
    tabId: 'tab',
    leafId: 'leaf',
    ptyId: 'pty',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true
  }
  let authority = {
    terminalHandle: 'term_self',
    paneKey: 'tab:leaf',
    processIncarnation: 'inc',
    hostScope: { kind: 'local' as const, hostId: 'local' as const }
  }
  let currentAuthority: Omit<TerminalMailboxSubscriptionBinding, 'createdAt'> | null = {
    ...authority,
    ptyId: 'pty'
  }
  const terminalMailboxSubscriptions = new TerminalMailboxSubscriptions(() => currentAuthority)
  const runtime = {
    verifyOrchestrationCompatibilityCaller: vi.fn((): typeof authority | null => authority),
    getOrchestrationDispatchAuthority: vi.fn(() => currentAuthority),
    orchestrationCompatibilityHostScopesEqual: vi.fn(
      (left, right) => JSON.stringify(left) === JSON.stringify(right)
    ),
    getLiveLeafForHandle: vi.fn().mockReturnValue({ leaf }),
    resolveOrchestrationPointerSubmitTarget: vi
      .fn()
      .mockReturnValue({ leaf, terminalHandle: 'term_self', processIncarnation: 'inc' }),
    orchestrationMailboxOwner: { resolve: vi.fn().mockReturnValue('term_self') },
    terminalMailboxSubscriptions,
    deliverPendingMessagesForHandle: vi.fn()
  }
  const invoke = (action: 'subscribe' | 'unsubscribe' | 'status') =>
    method.call(Object.assign(new OrcaRuntimeService(), runtime), action, {
      terminalHandle: 'term_self',
      paneKey: 'tab:leaf',
      launchToken: 'proof'
    })
  return {
    runtime,
    invoke,
    authority,
    disconnect: () => {
      currentAuthority = null
      runtime.getOrchestrationDispatchAuthority.mockReturnValue(null)
    },
    changeCurrent: (fields: Partial<Omit<TerminalMailboxSubscriptionBinding, 'createdAt'>>) => {
      currentAuthority = { ...currentAuthority!, ...fields }
      runtime.getOrchestrationDispatchAuthority.mockReturnValue(currentAuthority)
    },
    changeVerified: (fields: Partial<typeof authority>) => {
      authority = { ...authority, ...fields }
    }
  }
}

describe('receiver launch authority', () => {
  it('refuses an unverified caller before registering or writing', () => {
    const f = fixture()
    f.runtime.verifyOrchestrationCompatibilityCaller.mockReturnValue(null)
    expect(() => f.invoke('subscribe')).toThrow('verified current terminal launch')
    expect(f.runtime.deliverPendingMessagesForHandle).not.toHaveBeenCalled()
  })
  it('refuses Run/Dispatch ownership', () => {
    const f = fixture()
    f.runtime.orchestrationMailboxOwner.resolve.mockReturnValue('run:other')
    expect(() => f.invoke('subscribe')).toThrow('bare terminal')
  })
  it('registers self and immediately offers existing mail', () => {
    const f = fixture()
    expect(f.invoke('subscribe').subscribed).toBe(true)
    expect(f.runtime.verifyOrchestrationCompatibilityCaller).toHaveBeenCalledWith(
      expect.objectContaining({ launchToken: 'proof' }),
      { currentRuntimeLaunchSufficient: true }
    )
    expect(f.runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('term_self')
    const first = f.invoke('unsubscribe')
    expect(first.subscribed).toBe(false)
    expect(f.invoke('unsubscribe')).toEqual(first)
  })
  it('allows the original receiver to inspect and remove a subscription after Run ownership', () => {
    const f = fixture()
    f.invoke('subscribe')
    f.runtime.orchestrationMailboxOwner.resolve.mockReturnValue('run:other')
    f.runtime.getLiveLeafForHandle.mockClear()
    expect(f.invoke('status').subscribed).toBe(true)
    expect(f.invoke('unsubscribe')).toMatchObject({ subscribed: false, state: 'unsubscribed' })
    expect(f.runtime.getLiveLeafForHandle).not.toHaveBeenCalled()
  })
  it('does not let a replacement process manage the prior subscription', () => {
    const f = fixture()
    f.invoke('subscribe')
    f.changeCurrent({ processIncarnation: 'inc-other' })
    f.changeVerified({ processIncarnation: 'inc-other' })
    expect(() => f.invoke('status')).toThrow('different terminal identity')
    expect(() => f.invoke('unsubscribe')).toThrow('different terminal identity')
  })
  it.each([
    ['pane', { paneKey: 'tab:other' }],
    ['PTY', { ptyId: 'pty-other' }],
    ['process', { processIncarnation: 'inc-other' }],
    ['host', { hostScope: { kind: 'wsl' as const, hostId: 'local' as const, distro: 'Ubuntu' } }]
  ])('fails closed when the attested %s changes before registration', (_field, change) => {
    const f = fixture()
    f.changeCurrent(change)
    expect(() => f.invoke('subscribe')).toThrow('identity changed')
    expect(f.runtime.deliverPendingMessagesForHandle).not.toHaveBeenCalled()
  })
  it('keeps durable mail subscribed but marks a disconnected host unverifiable', () => {
    const f = fixture()
    f.invoke('subscribe')
    f.disconnect()
    expect(f.runtime.terminalMailboxSubscriptions.status('term_self')).toMatchObject({
      subscribed: true,
      state: 'host_unverifiable'
    })
  })
})
