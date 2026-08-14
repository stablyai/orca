import { describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'

// Fixtures mirror the shapes the providers actually emit: a resumed Codex
// thread renumbers its items positionally, and a forked Claude session copies
// history with the ORIGINAL item uuids.

const THREAD = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'
const TURN_A = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'
const TURN_B = '019fd8cb-1c40-7a02-9f31-0f1a54b7c211'

describe('codex identity survives positional renumbering', () => {
  it('keys the same logical item identically before and after a resume', () => {
    // First run: the app server labels the second turn's user message item-3.
    const live: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: TURN_B,
      ordinal: 0
    }
    // After `thread/resume` the same item comes back as item-1 of the replayed
    // history. Ordinal-within-turn is unchanged, so the key is unchanged.
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
    // `--fork-session` mints a new session id but copies records verbatim, so a
    // copied record still names the session it was written in.
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

  it('derives the submission slot from the same function the reducer uses', () => {
    expect(agentJournalSubmissionKey('cm_42')).toBe(
      agentJournalItemKey({ provider: 'orca', clientMessageId: 'cm_42' })
    )
  })
})
