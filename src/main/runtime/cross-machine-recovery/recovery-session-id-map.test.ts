import { describe, expect, it } from 'vitest'
import { descriptor, SESSION_ID } from './recovery-import.test-fixture'
import { applyRecoverySessionIdMap } from './recovery-session-id-map'

describe('applyRecoverySessionIdMap', () => {
  it('rewrites the id, the transcript basename and the structured cursor', () => {
    const [binding] = descriptor().bindings
    const source = {
      ...binding,
      providerSession: { ...binding.providerSession, transcriptPath: `/p/${SESSION_ID}.jsonl` },
      structuredCursor: { provider: 'claude' as const, sessionId: SESSION_ID, leafUuid: null }
    }
    const { bindings, sourceIds } = applyRecoverySessionIdMap(
      [source],
      [{ from: SESSION_ID, to: 'fork-1' }]
    )
    expect(bindings[0].providerSession).toEqual({
      key: binding.providerSession.key,
      id: 'fork-1',
      transcriptPath: '/p/fork-1.jsonl'
    })
    expect(bindings[0].structuredCursor?.sessionId).toBe('fork-1')
    expect(sourceIds.get('fork-1')).toBe(SESSION_ID)
  })

  it('refuses a mapping that names no binding', () => {
    expect(() =>
      applyRecoverySessionIdMap(descriptor().bindings, [{ from: 'nope', to: 'x' }])
    ).toThrow('recovery_binding_not_found')
  })
})
