import { describe, expect, it } from 'vitest'
import { structuredAgentSessionOwesUnloadedWork } from './structured-agent-session-close-work'

type Source = 'delivery' | 'acquire' | 'child' | 'ingress'

function state(owing: Source | null) {
  return {
    hasDeliveryWork: () => owing === 'delivery',
    acquireAborts: { has: () => owing === 'acquire' },
    childWork: { childWorkOpen: () => owing === 'child' },
    hasPendingIngress: () => owing === 'ingress'
  }
}

describe('work a chat owes with no agent loaded', () => {
  it.each(['delivery', 'acquire', 'child', 'ingress'] as const)('counts %s work', (source) => {
    expect(structuredAgentSessionOwesUnloadedWork(state(source), 's1')).toBe(true)
  })

  it('owes nothing when no source holds work', () => {
    expect(structuredAgentSessionOwesUnloadedWork(state(null), 's1')).toBe(false)
  })
})
