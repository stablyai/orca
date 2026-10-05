import { describe, expect, it } from 'vitest'
import { NativeChatInputGuard } from './native-chat-input-guard'
import type { NativeChatTargetRead } from '../../shared/native-chat-target-read'

const chat = (token = 'p.1'): NativeChatTargetRead => ({
  kind: 'chat-target',
  presentationToken: token
})
const terminal: NativeChatTargetRead = { kind: 'not-chat-target' }

describe('NativeChatInputGuard (derived from the committed presentation)', () => {
  it('admits while the pane shows chat and refuses once it does not, with no latch (R1B-1)', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty', 'inc', 'a', chat())).toBe('admitted')
    expect(guard.admit('pty', 'inc', 'b', terminal)).toBe('refused')
    // An explicit switch back to chat admits a NEW action at once; no hook or title is needed.
    expect(guard.admit('pty', 'inc', 'c', chat('p.3'))).toBe('admitted')
  })

  it('never reopens a refused action, even after chat returns', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty', 'inc', 'a', terminal)).toBe('refused')
    expect(guard.admit('pty', 'inc', 'a', chat())).toBe('refused')
  })

  it('cancels an admitted action whose presentation moved, even back to the same pair', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty', 'inc', 'a', chat('p.1'))).toBe('admitted')
    // chat(A) -> terminal -> chat(A) between the body and its Enter: a new token.
    expect(guard.admit('pty', 'inc', 'a', chat('p.3'))).toBe('refused')
    expect(guard.admit('pty', 'inc', 'a', chat('p.3'))).toBe('refused')
  })

  it('cancels an admitted action when its PTY incarnation changes', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty', 'inc-1', 'a', chat())).toBe('admitted')
    expect(guard.admit('pty', 'inc-2', 'a', chat())).toBe('refused')
  })

  it('treats an unreadable presentation as today (admit), never as an exit verdict', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('pty', 'inc', 'a', 'unverifiable')).toBe('admitted')
    expect(guard.admit('pty', 'inc', 'a', chat())).toBe('admitted')
    expect(guard.admit('pty', 'inc', 'b', 'unverifiable')).toBe('admitted')
  })

  it('refuses an unknown target without allocating any registry state (R1B-N2)', () => {
    const guard = new NativeChatInputGuard()
    expect(guard.admit('ghost', 'inc', 'a', { kind: 'unknown-target' })).toBe('refused')
    expect(guard['byPtyId'].size).toBe(0)
  })
})
