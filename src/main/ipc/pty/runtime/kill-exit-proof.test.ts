import { describe, expect, it, vi } from 'vitest'
import { PtyExitProof, PtyRetirementWithoutProof } from '../../../pty-exit-proof'
import { publishSyntheticExit } from './kill'

function harness() {
  const calls: string[] = []
  const runtime = {
    markPtyLivenessUnverifiable: (_id: string, reason: string) => {
      calls.push(`unverifiable:${reason}`)
    },
    onPtyExit: () => {
      calls.push('exit')
    }
  }
  const sendPtyExitToRenderer = vi.fn()
  const deps = {
    runtime,
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer
  }
  return { calls, deps, sendPtyExitToRenderer }
}

describe('a synthetic PTY exit', () => {
  it('reads unverifiable, before the exit lands, when it rests on no proof', () => {
    const { calls, deps, sendPtyExitToRenderer } = harness()
    const unproven = PtyRetirementWithoutProof.because('gone')
    publishSyntheticExit(deps, 'pty-1', -1, 'inc-1', unproven)
    expect(calls).toEqual(['unverifiable:gone', 'exit'])
    expect(sendPtyExitToRenderer).toHaveBeenCalledWith({
      id: 'pty-1',
      code: -1,
      incarnationId: 'inc-1'
    })
  })

  it('leaves the liveness verdict to the exit when the host proved it', () => {
    const { calls, deps } = harness()
    publishSyntheticExit(deps, 'pty-1', 0, undefined, PtyExitProof.from('absent', undefined))
    expect(calls).toEqual(['exit'])
  })
})
