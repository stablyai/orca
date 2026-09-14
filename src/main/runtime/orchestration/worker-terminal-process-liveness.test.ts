import { describe, expect, it } from 'vitest'
import type { PtyProcessInfo } from '../../providers/pty-process-info'
import { classifyWorkerTerminalProcessIncarnation } from './worker-terminal-process-liveness'

// Residual B: an empty inventory can mean the host never listed this scope at all (restarted
// relay, in-process-only local scope, partial enumeration) — not proof the process died. Only a
// listing that names this pty id under a *different* incarnation is positive remint evidence.
describe('classifyWorkerTerminalProcessIncarnation', () => {
  it('answers unverifiable, not exited, when the inventory lists nothing for this pty', () => {
    const sessions: readonly PtyProcessInfo[] = []

    expect(classifyWorkerTerminalProcessIncarnation('pty-1:inc-1', sessions)).toBe('unverifiable')
  })

  it('answers unverifiable when the listing omits this pty id but reports others', () => {
    const sessions: readonly PtyProcessInfo[] = [
      { id: 'pty-2', incarnationId: 'inc-9', cwd: '', title: 'other' }
    ]

    expect(classifyWorkerTerminalProcessIncarnation('pty-1:inc-1', sessions)).toBe('unverifiable')
  })

  it('answers exited when the host lists this pty id under a newer incarnation', () => {
    const sessions: readonly PtyProcessInfo[] = [
      { id: 'pty-1', incarnationId: 'inc-2', cwd: '', title: 'worker' }
    ]

    expect(classifyWorkerTerminalProcessIncarnation('pty-1:inc-1', sessions)).toBe('exited')
  })

  it('answers live when the host lists this pty id under the exact incarnation', () => {
    const sessions: readonly PtyProcessInfo[] = [
      { id: 'pty-1', incarnationId: 'inc-1', cwd: '', title: 'worker' }
    ]

    expect(classifyWorkerTerminalProcessIncarnation('pty-1:inc-1', sessions)).toBe('live')
  })
})
