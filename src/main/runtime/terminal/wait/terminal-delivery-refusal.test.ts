import { describe, expect, it } from 'vitest'
import { terminalDeliveryRefusal } from './terminal-delivery-refusal'

const refusal = (
  verdict: Parameters<typeof terminalDeliveryRefusal>[0]['verdict'],
  recognizedAgent = true,
  veto = false
) => terminalDeliveryRefusal({ verdict, recognizedAgent, readScreenInputVeto: () => veto })

describe('terminal delivery refusal', () => {
  it('types into a ready terminal, or a recognized agent mid-turn with nothing on screen', () => {
    expect(refusal({ kind: 'ready-strong' })).toBeNull()
    expect(refusal({ kind: 'ready-weak' })).toBeNull()
    expect(refusal({ kind: 'working' })).toBeNull()
  })

  it('says why it holds: an unknown program, an overlay, a blocker, or an unsettled terminal', () => {
    expect(refusal({ kind: 'working' }, false)).toEqual({ kind: 'busy-program' })
    expect(refusal({ kind: 'working' }, true, true)).toEqual({ kind: 'overlay' })
    expect(refusal({ kind: 'blocked', reason: 'codex-trust-workspace' })).toEqual({
      kind: 'blocked',
      reason: 'codex-trust-workspace'
    })
    expect(refusal({ kind: 'pending', quietForeground: 'closed' })).toEqual({ kind: 'unsettled' })
  })
})
