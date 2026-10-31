import { describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  boundJournalKeyComponent,
  MAX_JOURNAL_KEY_COMPONENT_CHARS,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'

const THREAD = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'
const TURN_A = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'
const TURN_B = '019fd8cb-1c40-7a02-9f31-0f1a54b7c211'

describe('codex identity survives positional renumbering', () => {
  it('keys the same logical item identically before and after a resume', () => {
    const live: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_B,
      ordinal: 0
    }
    // Resume renumbers raw IDs; stable turn ordinals must preserve identity.
    const resumed: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_B,
      ordinal: 0
    }
    expect(agentJournalItemKey(resumed)).toBe(agentJournalItemKey(live))
  })

  it('separates two items inside one turn', () => {
    const first = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_A,
      ordinal: 0
    })
    const second = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_A,
      ordinal: 1
    })
    expect(first).not.toBe(second)
  })

  it('disambiguates a fork that copies turns keeping their original turn ids', () => {
    const original = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_A,
      ordinal: 0
    })
    const forked = agentJournalItemKey({
      provider: 'codex',
      threadId: '019fd900-77aa-7c19-8bd0-2b3c4d5e6f70',
      turnId: TURN_A,
      ordinal: 0
    })
    expect(forked).not.toBe(original)
  })
})

describe('claude identity', () => {
  it('keys on (session id, uuid)', () => {
    const key = agentJournalItemKey({
      provider: 'claude',
      sessionId: '29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88',
      uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    })
    expect(key).toBe(
      'claude:29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88:c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    )
  })

  it('reconciles a forked transcript onto the parent item rather than duplicating it', () => {
    // Forks copy original item UUIDs and session IDs unchanged.
    const parent = agentJournalItemKey({
      provider: 'claude',
      sessionId: '29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88',
      uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    })
    const copiedIntoFork = agentJournalItemKey({
      provider: 'claude',
      sessionId: '29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88',
      uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    })
    expect(copiedIntoFork).toBe(parent)
  })

  it('keeps a genuinely new item in the fork distinct', () => {
    const parent = agentJournalItemKey({
      provider: 'claude',
      sessionId: '29eb22a4-6a5f-4f21-9b0c-1d7f3a2e5c88',
      uuid: 'c1a5f0de-2b44-4a11-9f0e-7c2d31b6aa04'
    })
    const minted = agentJournalItemKey({
      provider: 'claude',
      sessionId: '7b1e5d33-0f28-42ac-8d59-9a4c6e2b1f70',
      uuid: 'f8b2c9a1-3e77-4c60-b1a2-5d0e7f4a9c33'
    })
    expect(minted).not.toBe(parent)
  })
})

describe('key encoding', () => {
  it('cannot be collided by a separator inside an id', () => {
    const a = agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'a:b',
      recordId: 'c'
    })
    const b = agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'a',
      recordId: 'b:c'
    })
    expect(a).not.toBe(b)
  })

  it('separates the provider namespaces', () => {
    const orca = agentJournalItemKey({ provider: 'orca', clientMessageId: 'x' })
    const legacy = agentJournalItemKey({
      provider: 'legacy',
      agent: 'claude',
      sessionId: 'x',
      recordId: 'x'
    })
    expect(orca).not.toBe(legacy)
  })
})

describe('bounded component domain separation', () => {
  const oversizedTurnId = 'a'.repeat(MAX_JOURNAL_KEY_COMPONENT_CHARS + 1)
  const digestFormMimic = boundJournalKeyComponent(oversizedTurnId)
  const keyFor = (turnId: string) =>
    agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId, ordinal: 0 })

  it('separates an oversized component from the raw string matching its digest form', () => {
    const oversizedKey = keyFor(oversizedTurnId)
    expect(oversizedKey).toBe(`codex:${THREAD}:${digestFormMimic}:0`)
    expect(oversizedKey).not.toBe(keyFor(digestFormMimic))
  })

  it('keeps both persisted key spellings stable through parse and re-key', () => {
    for (const turnId of [oversizedTurnId, digestFormMimic]) {
      const key = keyFor(turnId)
      const parsed = parseAgentJournalItemKey(key)
      expect(parsed).not.toBeNull()
      expect(agentJournalItemKey(parsed as AgentJournalItemIdentity)).toBe(key)
    }
    expect(parseAgentJournalItemKey(keyFor(digestFormMimic))).toEqual({
      provider: 'codex',
      threadId: THREAD,
      turnId: digestFormMimic,
      ordinal: 0
    })
  })
})

describe('oversized identity bounding on Unicode boundaries', () => {
  // Split an astral pair at the old 40-unit diagnostic cut to exercise Unicode-safe bounding.
  const STRADDLING = `${'a'.repeat(39)}😀${'x'.repeat(1100)}`
  const straddlingIdentity: AgentJournalItemIdentity = {
    provider: 'codex',
    threadId: THREAD,
    turnId: STRADDLING,
    ordinal: 0
  }

  it('keys a valid astral id whose character straddles the head cut', () => {
    expect(() => agentJournalItemKey(straddlingIdentity)).not.toThrow()
    expect(boundJournalKeyComponent(STRADDLING).length).toBeLessThan(
      MAX_JOURNAL_KEY_COMPONENT_CHARS
    )
  })

  it('stays deterministic and collision-resistant for straddling ids', () => {
    expect(agentJournalItemKey(straddlingIdentity)).toBe(agentJournalItemKey(straddlingIdentity))
    expect(agentJournalItemKey({ ...straddlingIdentity, turnId: `${STRADDLING}y` })).not.toBe(
      agentJournalItemKey(straddlingIdentity)
    )
  })

  it('re-deriving from the parsed bounded key is a fixed point', () => {
    const key = agentJournalItemKey(straddlingIdentity)
    const parsed = parseAgentJournalItemKey(key)
    expect(parsed).not.toBeNull()
    expect(agentJournalItemKey(parsed as AgentJournalItemIdentity)).toBe(key)
  })

  it('keeps an astral character that lands entirely inside the head', () => {
    const inside = `${'a'.repeat(38)}😀${'x'.repeat(1100)}`
    const bounded = boundJournalKeyComponent(inside)
    expect(bounded.startsWith(`${'a'.repeat(38)}😀~orca-oversized~`)).toBe(true)
    expect(() => encodeURIComponent(bounded)).not.toThrow()
  })

  it('drops only the split surrogate from the straddling head', () => {
    const bounded = boundJournalKeyComponent(STRADDLING)
    expect(bounded.startsWith(`${'a'.repeat(39)}~orca-oversized~`)).toBe(true)
    expect(() => encodeURIComponent(bounded)).not.toThrow()
  })
})

describe('ill-formed UTF-16 identity totality', () => {
  // JSON permits lone surrogates, so identity encoding must handle them without URIError.
  const LONE_HIGH = '\ud83d'
  const LONE_LOW = '\ude00'

  it('keys a lone-high-surrogate id without throwing, deterministically', () => {
    const identity: AgentJournalItemIdentity = {
      provider: 'claude',
      sessionId: LONE_HIGH,
      uuid: 'u-1'
    }
    expect(() => agentJournalItemKey(identity)).not.toThrow()
    expect(agentJournalItemKey(identity)).toBe(agentJournalItemKey(identity))
  })

  it('keys an oversized id carrying a lone low surrogate inside the head', () => {
    const identity: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: `${LONE_LOW}${'x'.repeat(1100)}`,
      ordinal: 0
    }
    expect(() => agentJournalItemKey(identity)).not.toThrow()
  })

  it('keys an oversized id with a lone high surrogate away from the head cut', () => {
    const identity: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: `${'a'.repeat(10)}${LONE_HIGH}${'b'.repeat(1100)}`,
      ordinal: 0
    }
    expect(() => agentJournalItemKey(identity)).not.toThrow()
  })

  it('cannot collide an ill-formed id with its replacement-character spelling', () => {
    const keyFor = (sessionId: string) =>
      agentJournalItemKey({ provider: 'claude', sessionId, uuid: 'u-1' })
    expect(keyFor(LONE_HIGH)).not.toBe(keyFor('�'))
    expect(keyFor(LONE_HIGH)).not.toBe(keyFor(LONE_LOW))
    const oversized = (head: string) => `${head}${'x'.repeat(1100)}`
    expect(keyFor(oversized(LONE_HIGH))).not.toBe(keyFor(oversized('�')))
  })

  it('re-deriving from a parsed ill-formed key is a fixed point', () => {
    const key = agentJournalItemKey({ provider: 'claude', sessionId: LONE_HIGH, uuid: 'u-1' })
    const parsed = parseAgentJournalItemKey(key)
    expect(parsed).not.toBeNull()
    expect(agentJournalItemKey(parsed as AgentJournalItemIdentity)).toBe(key)
  })

  it('leaves well-formed short components verbatim', () => {
    expect(boundJournalKeyComponent('turn-1')).toBe('turn-1')
    expect(boundJournalKeyComponent('😀 café')).toBe('😀 café')
  })
})

describe('malformed persisted keys decode to null instead of throwing', () => {
  it('returns null for malformed percent sequences', () => {
    for (const key of ['%', 'claude:%E0%A4%A:u-1', 'codex:a:b:1%ZZ', 'claude:%ED%A0%BD:u-1']) {
      expect(parseAgentJournalItemKey(key)).toBeNull()
    }
  })

  it('still round-trips well-formed keys containing the delimiter and spaces', () => {
    const identity: AgentJournalItemIdentity = {
      provider: 'claude',
      sessionId: 's:1',
      uuid: 'u 1'
    }
    expect(parseAgentJournalItemKey(agentJournalItemKey(identity))).toEqual(identity)
  })
})
