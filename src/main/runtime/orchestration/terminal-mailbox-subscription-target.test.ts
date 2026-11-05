import { describe, expect, it } from 'vitest'
import { resolveTerminalMailboxSubscriptionTerminal } from './terminal-mailbox-subscription-target'
import type { CurrentTerminalMailboxAuthority } from './terminal-mailbox-subscriptions'

function fixture() {
  const binding: CurrentTerminalMailboxAuthority = {
    hostScope: { kind: 'local', hostId: 'local' },
    terminalHandle: 'term_self',
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    ptyId: 'pty-1',
    processIncarnation: 'pty-1:inc-1'
  }
  const terminal = {
    handle: 'term_self',
    ptyId: 'pty-1',
    paneKeys: ['tab-1:11111111-1111-4111-8111-111111111111'],
    lastAgentStatus: 'idle' as const,
    lastAgentStatusObservedLive: true
  }
  return { binding, current: binding, terminal }
}

describe('attested native mailbox subscription target', () => {
  it('uses the execution host terminal without requiring a viewer leaf', () => {
    const input = fixture()
    expect(resolveTerminalMailboxSubscriptionTerminal(input)).toBe(input.terminal)
  })
  it.each(['terminalHandle', 'paneKey', 'ptyId', 'processIncarnation'] as const)(
    'refuses changed %s',
    (field) => {
      const input = fixture()
      expect(
        resolveTerminalMailboxSubscriptionTerminal({
          ...input,
          current: { ...input.current, [field]: 'changed' }
        })
      ).toBeNull()
    }
  )
  it('refuses unavailable or different host authority', () => {
    const input = fixture()
    expect(resolveTerminalMailboxSubscriptionTerminal({ ...input, current: null })).toBeNull()
    expect(
      resolveTerminalMailboxSubscriptionTerminal({
        ...input,
        current: { ...input.current, hostScope: { kind: 'ssh', targetId: 'other' } }
      })
    ).toBeNull()
  })
  it('refuses an absent, replaced or renamed terminal', () => {
    const input = fixture()
    for (const terminal of [
      null,
      { ...input.terminal, ptyId: 'other' },
      { ...input.terminal, handle: 'term_other' }
    ]) {
      expect(resolveTerminalMailboxSubscriptionTerminal({ ...input, terminal })).toBeNull()
    }
  })
  it('refuses missing, changed, duplicated and shared pane bindings', () => {
    const input = fixture()
    for (const paneKeys of [
      [],
      ['tab:other'],
      [input.binding.paneKey, input.binding.paneKey],
      [input.binding.paneKey, 'tab:other']
    ]) {
      expect(
        resolveTerminalMailboxSubscriptionTerminal({
          ...input,
          terminal: { ...input.terminal, paneKeys }
        })
      ).toBeNull()
    }
  })
})
