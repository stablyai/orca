import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { TerminalStreamInputFailure } from '../transport/terminal-stream-input-failure'
import { useTerminalInputRecovery } from './use-terminal-input-recovery'

function harness() {
  let detail: TerminalStreamInputFailure | null = { outcome: 'unknown', reason: 'timeout' }
  const recover = vi.fn(() => {
    detail = null
    return true
  })
  const client = {
    getTerminalStreamInputFailure: () => detail,
    cancelTerminalStreamInput: vi.fn(),
    recoverTerminalStreamInput: recover
  } as unknown as RpcClient
  const options = {
    client,
    getSendCompletionGeneration: vi.fn(() => 1),
    getLiveInteractionGeneration: vi.fn(() => 1),
    activeHandle: 'a',
    activeHandleRef: { current: 'a' },
    clientRef: { current: client },
    clearPendingLiveInputCommit: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    terminalInputSubscribedRef: { current: (_handle: string) => {} }
  }
  let value!: ReturnType<typeof useTerminalInputRecovery>
  function Probe() {
    value = useTerminalInputRecovery(options)
    return null
  }
  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe))
  })
  return {
    options,
    client,
    recover,
    get: () => value,
    render: () => act(() => renderer.update(createElement(Probe))),
    close: () => act(() => renderer.unmount())
  }
}

describe('terminal input explicit recovery', () => {
  it('does not turn a late pre-recovery failure into a new legacy warning', () => {
    const h = harness()
    try {
      const lateFailure = h.get().captureTerminalInputFailureReporter('a', h.client)
      act(() => h.get().recoverTerminalInput())
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      act(() => lateFailure())
      expect(h.get().terminalInputFailure).toBeNull()
    } finally {
      h.close()
    }
  })
  it('requires a user action and fresh subscription, and never replays text', () => {
    const h = harness()
    try {
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.recover).not.toHaveBeenCalled()
      act(() => h.get().recoverTerminalInput())
      expect(h.options.clearPendingLiveInputCommit).toHaveBeenCalledTimes(1)
      expect(h.client.cancelTerminalStreamInput).toHaveBeenCalledWith('a')
      expect(h.options.unsubscribeTerminal).toHaveBeenCalledWith('a')
      expect(h.options.subscribeToTerminal).toHaveBeenCalledWith('a')
      expect(h.get().terminalInputFailure?.outcome).toBe('unknown')
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.recover).toHaveBeenCalledWith('a')
      expect(h.get().terminalInputFailure).toBeNull()
    } finally {
      h.close()
    }
  })

  it('does not recover a new route from a late subscription event', () => {
    const h = harness()
    try {
      act(() => h.get().recoverTerminalInput())
      h.options.activeHandleRef.current = 'b'
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.recover).not.toHaveBeenCalled()
    } finally {
      h.close()
    }
  })

  it('keeps the warning if the replacement subscription cannot recover', () => {
    const h = harness()
    try {
      h.recover.mockReturnValue(false)
      act(() => h.get().recoverTerminalInput())
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.get().terminalInputFailure?.outcome).toBe('unknown')
      expect(h.get().terminalInputRecoveryUnavailable).toBe(true)
    } finally {
      h.close()
    }
  })

  it('shows an old-host JSON failure and resumes only after explicit resubscription', () => {
    const h = harness()
    try {
      h.client.getTerminalStreamInputFailure = () => null
      h.recover.mockReturnValue(false)
      act(() => h.get().reportTerminalInputFailure('a', h.client, true))
      expect(h.get().terminalInputFailure?.reason).toBe('legacy_send_failed')
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.get().terminalInputFailure).not.toBeNull()
      act(() => h.get().recoverTerminalInput())
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.get().terminalInputFailure).toBeNull()
    } finally {
      h.close()
    }
  })

  it('a legacy warning cannot clear a later negotiated uncertain-prefix fence', () => {
    const h = harness()
    try {
      h.client.getTerminalStreamInputFailure = () => null
      h.recover.mockReturnValue(false)
      act(() => h.get().reportTerminalInputFailure('a', h.client, true))
      h.client.getTerminalStreamInputFailure = () => ({
        outcome: 'unknown',
        reason: 'receipt_timeout'
      })
      act(() => h.get().recoverTerminalInput())
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.get().terminalInputFailure?.reason).toBe('receipt_timeout')
      expect(h.get().terminalInputRecoveryUnavailable).toBe(true)
    } finally {
      h.close()
    }
  })

  it('invalidates recovery across A to B to A even when the late event arrives back on A', () => {
    const h = harness()
    try {
      act(() => h.get().recoverTerminalInput())
      h.options.activeHandle = h.options.activeHandleRef.current = 'b'
      h.render()
      h.options.activeHandle = h.options.activeHandleRef.current = 'a'
      h.render()
      act(() => h.options.terminalInputSubscribedRef.current('a'))
      expect(h.recover).not.toHaveBeenCalled()
    } finally {
      h.close()
    }
  })

  it.each(['getSendCompletionGeneration', 'getLiveInteractionGeneration'] as const)(
    'does not clear newer input after %s changes',
    (field) => {
      const h = harness()
      try {
        act(() => h.get().recoverTerminalInput())
        h.options[field].mockReturnValue(2)
        act(() => h.options.terminalInputSubscribedRef.current('a'))
        expect(h.recover).not.toHaveBeenCalled()
        expect(h.options.clearPendingLiveInputCommit).toHaveBeenCalledTimes(1)
      } finally {
        h.close()
      }
    }
  )
})
