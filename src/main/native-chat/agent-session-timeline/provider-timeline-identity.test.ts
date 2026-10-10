import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  createLegacyProviderTimelineIdentityScheme,
  providerTimelineKeyPart,
  spellProviderTimelineKey
} from './provider-timeline-identity'

const scheme = createLegacyProviderTimelineIdentityScheme({ agent: 'grok', sessionId: 's1' })
const provider = (value: string) => ({ source: 'provider', value }) as const

describe('provider timeline identity spelling', () => {
  it('escapes a key so it cannot forge another part', () => {
    expect(providerTimelineKeyPart('a:b/c')).toBe('a%3Ab%2Fc')
    expect(spellProviderTimelineKey('ns', provider('x:y'))).not.toBe(
      spellProviderTimelineKey('ns:x', provider('y'))
    )
  })

  it('bounds a long key by a digest, so two long keys with one prefix stay apart', () => {
    const head = 'k'.repeat(400)
    const one = providerTimelineKeyPart(`${head}1`)
    const two = providerTimelineKeyPart(`${head}2`)
    expect(Buffer.byteLength(one, 'utf8')).toBeLessThanOrEqual(256)
    expect(one).not.toBe(two)
  })

  it('spells an item per thread, and a minted key apart from any provider one', () => {
    const item = (thread: string | null) =>
      agentJournalItemKey(
        scheme.item({ namespace: 'ns', family: 'item', key: provider('m1'), thread })
      )
    expect(new Set([item(null), item('root'), item('child')]).size).toBe(3)
    expect(spellProviderTimelineKey('ns', { source: 'minted', value: 'gen-1:s1' })).toBe(
      'm:gen-1%3As1'
    )
  })

  it('spells a request in the acquisition that asked it, with its incarnation', () => {
    const request = (generation: string, incarnation: number) =>
      scheme.request({ generation, key: '0', incarnation })
    expect(request('gen-1', 1)).toMatchObject({ provider: 'legacy', recordId: 'request:g:gen-1:0' })
    expect(request('gen-1', 2)).toMatchObject({ recordId: 'request:g:gen-1:0#2' })
    expect(agentJournalItemKey(request('gen-2', 1))).not.toBe(
      agentJournalItemKey(request('gen-1', 1))
    )
  })

  it('keeps turn rows on the record prefix every lane writes', () => {
    const turn = { namespace: 'ns', key: provider('t1') }
    expect(scheme.turn(turn)).toMatchObject({ recordId: 'turn-lifecycle:p:ns:t1' })
    expect(scheme.turnId(turn)).toBe('p:ns:t1')
  })
})
