import { describe, expect, it } from 'vitest'
import { resolveTerminalMailboxSubscriptionLeaf } from './terminal-mailbox-subscription-target'
import type { CurrentTerminalMailboxAuthority } from './terminal-mailbox-subscriptions'

function fixture() {
  const binding: CurrentTerminalMailboxAuthority = {
    hostScope: { kind: 'local', hostId: 'local' },
    terminalHandle: 'term_self',
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    ptyId: 'pty-1',
    processIncarnation: 'pty-1:inc-1'
  }
  const pty = {
    ptyId: binding.ptyId,
    paneKey: binding.paneKey,
    tabId: 'tab-1',
    connected: true,
    lastAgentStatus: 'idle' as const,
    lastAgentStatusObservedLive: true,
    lastOscTitle: 'Codex ready'
  }
  const input = {
    binding,
    current: binding,
    ptys: [pty],
    leaves: [],
    handleForPty: () => binding.terminalHandle,
    handleForLeaf: () => binding.terminalHandle
  }
  return { binding, pty, input }
}

describe('attested native mailbox subscription target', () => {
  it('uses the execution host PTY without requiring a viewer leaf', () => {
    const { input } = fixture()
    expect(resolveTerminalMailboxSubscriptionLeaf(input)).toMatchObject({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty-1',
      writable: true,
      lastAgentStatus: 'idle',
      lastAgentStatusObservedLive: true
    })
  })
  it.each(['terminalHandle', 'paneKey', 'ptyId', 'processIncarnation'] as const)(
    'refuses changed %s',
    (field) => {
      const { input } = fixture()
      expect(
        resolveTerminalMailboxSubscriptionLeaf({
          ...input,
          current: { ...input.current, [field]: 'changed' }
        })
      ).toBeNull()
    }
  )
  it('refuses unavailable or different host authority', () => {
    const { input } = fixture()
    expect(resolveTerminalMailboxSubscriptionLeaf({ ...input, current: null })).toBeNull()
    expect(
      resolveTerminalMailboxSubscriptionLeaf({
        ...input,
        current: { ...input.current, hostScope: { kind: 'ssh', targetId: 'other' } }
      })
    ).toBeNull()
  })
  it('refuses disconnected, conflicting and duplicated PTYs', () => {
    const { input, pty } = fixture()
    for (const ptys of [
      [{ ...pty, connected: false }],
      [{ ...pty, tabId: 'other' }],
      [{ ...pty, paneKey: 'other' }],
      [pty, { ...pty, ptyId: 'other' }],
      [pty, { ...pty, paneKey: 'other' }]
    ]) {
      expect(resolveTerminalMailboxSubscriptionLeaf({ ...input, ptys })).toBeNull()
    }
  })
  it('refuses absent or different handle mappings', () => {
    const { input } = fixture()
    expect(
      resolveTerminalMailboxSubscriptionLeaf({ ...input, handleForPty: () => undefined })
    ).toBeNull()
    expect(
      resolveTerminalMailboxSubscriptionLeaf({ ...input, handleForPty: () => 'term_other' })
    ).toBeNull()
  })
  it('preserves a matching mounted leaf and fails closed on conflicting leaves', () => {
    const { input } = fixture()
    const leaf = resolveTerminalMailboxSubscriptionLeaf(input)!
    expect(resolveTerminalMailboxSubscriptionLeaf({ ...input, leaves: [leaf] })).toBe(leaf)
    for (const leaves of [
      [leaf, { ...leaf, tabId: 'other' }],
      [{ ...leaf, ptyId: 'other' }],
      [{ ...leaf, tabId: 'other' }]
    ]) {
      expect(resolveTerminalMailboxSubscriptionLeaf({ ...input, leaves })).toBeNull()
    }
    expect(
      resolveTerminalMailboxSubscriptionLeaf({
        ...input,
        leaves: [leaf],
        handleForLeaf: () => 'term_other'
      })
    ).toBeNull()
  })
})
