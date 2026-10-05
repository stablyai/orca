import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import { nextConversationFacet } from './server-conversation-facet'
import type { EnrichedAgentHookEventPayload, StoredAgentConversation } from './server-types'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const S: AgentProviderSessionMetadata = { key: 'session_id', id: 'S', transcriptPath: '/t/S.jsonl' }
const C: AgentProviderSessionMetadata = { key: 'session_id', id: 'C' }

function admitted(
  providerSession: AgentProviderSessionMetadata | undefined,
  payload: Partial<AgentHookEventPayload['payload']> = {}
): AgentHookEventPayload {
  return {
    paneKey: PANE,
    connectionId: null,
    ...(providerSession ? { providerSession } : {}),
    payload: { state: 'working', prompt: '', agentType: 'codex', ...payload }
  }
}

function row(
  providerSession: AgentProviderSessionMetadata | undefined,
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return {
    ...admitted(providerSession, { model: 'P' }),
    receivedAt: 50,
    stateStartedAt: 50,
    ...overrides
  }
}

const facetSP: StoredAgentConversation = {
  agentType: 'codex',
  providerSession: S,
  model: 'P',
  capturedAt: 10
}

describe('nextConversationFacet', () => {
  it('returns the same facet for a kept report with the same address and model pair', () => {
    expect(nextConversationFacet(facetSP, row(S), admitted(S, { model: 'P' }), S, 99)).toBe(facetSP)
  })

  it('returns the same facet for a kept report of the same address with no model', () => {
    expect(nextConversationFacet(facetSP, row(S), admitted(S), S, 99)).toBe(facetSP)
  })

  it('takes a newer model pair for the same address once, then is idempotent', () => {
    const next = nextConversationFacet(
      facetSP,
      row(S),
      admitted(S, { model: 'Q', modelSwitchCommand: 'orca-model' }),
      S,
      99
    )
    expect(next).toEqual({
      agentType: 'codex',
      providerSession: S,
      model: 'Q',
      modelSwitchCommand: 'orca-model',
      capturedAt: 99
    })
    const again = nextConversationFacet(
      next,
      row(S),
      admitted(S, { model: 'Q', modelSwitchCommand: 'orca-model' }),
      S,
      120
    )
    expect(again).toBe(next)
  })

  it.each([
    ['a new id', { key: 'session_id' as const, id: 'T' }],
    ['the same id at a new path', { ...S, transcriptPath: '/t/other.jsonl' }],
    ['a new key', { key: 'conversation_id' as const, id: 'S', transcriptPath: S.transcriptPath }]
  ])('replaces the facet for %s without inheriting the model', (_name, session) => {
    expect(nextConversationFacet(facetSP, row(S), admitted(session), session, 99)).toEqual({
      agentType: 'codex',
      providerSession: session,
      capturedAt: 99
    })
  })

  it('replaces the facet when another agent reports and admission keeps it', () => {
    expect(
      nextConversationFacet(facetSP, row(S), admitted(C, { agentType: 'claude' }), C, 99)
    ).toEqual({ agentType: 'claude', providerSession: C, capturedAt: 99 })
  })

  it('never moves on a carried write, even when it names an address', () => {
    expect(nextConversationFacet(facetSP, row(S), admitted(C, { model: 'Q' }), null, 99)).toBe(
      facetSP
    )
    expect(nextConversationFacet(facetSP, row(S), admitted(undefined), null, 99)).toBe(facetSP)
  })

  it('keeps the facet when admission substituted a borrowed owner address (#24297 shape)', () => {
    expect(nextConversationFacet(facetSP, row(S), admitted(S, { model: 'Q' }), C, 99)).toBe(facetSP)
  })

  it('keeps the facet when admission dropped the reported address', () => {
    expect(nextConversationFacet(facetSP, row(S), admitted(undefined), S, 99)).toBe(facetSP)
  })

  it('treats a kept report decorated with resume metadata as kept, by locator', () => {
    // Why a spread: the resume decoration is a member this tree's type does not declare yet.
    const decoration = { resumeIdentity: { agent: 'codex' } }
    const decorated: AgentProviderSessionMetadata = { ...S, ...decoration }
    expect(
      nextConversationFacet(undefined, undefined, admitted(decorated, { model: 'P' }), S, 99)
    ).toMatchObject({ providerSession: decorated, model: 'P', capturedAt: 99 })
  })

  it('seeds a facet-less row from its own legacy address, never from the incoming report', () => {
    const legacy = row(S)
    expect(nextConversationFacet(undefined, legacy, admitted(C), null, 99)).toEqual({
      agentType: 'codex',
      providerSession: S,
      model: 'P',
      capturedAt: 50
    })
  })

  it('leaves an addressless row without a facet until a kept report sets one', () => {
    expect(
      nextConversationFacet(undefined, row(undefined), admitted(undefined), null, 99)
    ).toBeUndefined()
    expect(nextConversationFacet(undefined, row(undefined), admitted(S), S, 99)).toEqual({
      agentType: 'codex',
      providerSession: S,
      capturedAt: 99
    })
  })

  it('ignores a report from an unknown agent', () => {
    expect(
      nextConversationFacet(facetSP, row(S), admitted(C, { agentType: 'unknown' }), C, 99)
    ).toBe(facetSP)
  })
})
