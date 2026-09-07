// Repro for rapid-double-send data corruption (unfiled; probed live 2026-09-07).
//
// Proven against codex-cli 0.153.4 (`codex app-server` over stdio): `turn/start`
// issued while a turn is active does NOT open a new turn — it coalesces the
// message into the RUNNING turn and returns that turn's id. Both user messages
// then live in ONE turn, at message ordinals 0 and 2.
//
// Orca's `dispatchCodexTurn` stamps every accepted send with ordinal 0
// (CODEX_USER_MESSAGE_ORDINAL), so the second submission adopts the FIRST
// message's provider identity. `applyDispatch` re-points the alias for that key
// to the second submission, and the second message's true identity (ordinal 2)
// is claimed by nobody — so a resume/history replay appends it as a brand-new
// bubble: the prompt renders twice.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import {
  createCodexDispatchEchoes,
  resolveCodexUserMessageEcho
} from '../../codex/codex-structured-dispatch-echo'
import { dispatchCodexTurn, type CodexTurnHost } from '../../codex/codex-structured-turn-start'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function codexItem(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function userBody(text: string): Extract<AgentJournalItemBody, { kind: 'message' }> {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantBody(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

function fingerprint(body: AgentJournalItemBody): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: IDENTITY.sessionId,
    fields: { body }
  })
}

/** Codex app-server as probed: a turn/start during an active turn answers with
 *  the ACTIVE turn (same id), exactly once per request, `turn/started` fires
 *  only for the first, and each accepted message is echoed back as a
 *  `userMessage` item carrying the client id — A at ordinal 0, B at ordinal 2
 *  (an agent reply sits between them). */
function coalescingCodexHost(): CodexTurnHost {
  const host: CodexTurnHost = {
    threadId: 'thread-1',
    options: new Map(),
    turnIdWaiters: [],
    activeTurnIds: new Set(),
    dispatchEchoes: createCodexDispatchEchoes(),
    connection: {
      request: async (_method, params) => {
        const clientId =
          (params as { clientUserMessageId?: string } | undefined)?.clientUserMessageId ?? null
        queueMicrotask(() =>
          resolveCodexUserMessageEcho(host.dispatchEchoes, 'thread-1', {
            threadId: 'thread-1',
            clientId,
            identity: codexItem(clientId === 'msg-A' ? 0 : 2)
          })
        )
        return { turn: { id: 'turn-1', status: 'inProgress' } }
      }
    }
  }
  return host
}

const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'journal-rapid-send-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('rapid second send while a codex turn is active', () => {
  it('keeps each prompt as exactly one bubble across a thread restore', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      journalDir: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`
    })
    const promptA = userBody('first prompt')
    const promptB = userBody('second prompt')
    const host = coalescingCodexHost()

    // Send A — performSend order: submission row, then dispatch, then resolution.
    await journal.appendSubmission({
      clientMessageId: 'msg-A',
      payloadFingerprint: fingerprint(promptA),
      body: promptA,
      fence: 0
    })
    const outcomeA = await dispatchCodexTurn(host, { clientMessageId: 'msg-A', body: promptA }, 50)
    if (outcomeA.state !== 'accepted') {
      throw new Error(`dispatch A ${outcomeA.state}`)
    }
    await journal.resolveDispatch({
      clientMessageId: 'msg-A',
      state: 'accepted',
      providerIdentity: outcomeA.providerIdentity,
      fence: 0
    })

    // Rapid send B while turn-1 is still running: codex coalesces it into
    // turn-1 and answers turn/start with the same turn id (probed live).
    await journal.appendSubmission({
      clientMessageId: 'msg-B',
      payloadFingerprint: fingerprint(promptB),
      body: promptB,
      fence: 0
    })
    const outcomeB = await dispatchCodexTurn(host, { clientMessageId: 'msg-B', body: promptB }, 50)
    if (outcomeB.state !== 'accepted') {
      throw new Error(`dispatch B ${outcomeB.state}`)
    }
    await journal.resolveDispatch({
      clientMessageId: 'msg-B',
      state: 'accepted',
      providerIdentity: outcomeB.providerIdentity,
      fence: 0
    })

    // Live replies stream in one turn; message ordinals count user+agent
    // messages in order: A=0, reply=1, B=2, reply=3 (probed live).
    await journal.appendItem(codexItem(1), assistantBody('reply to first'), { fence: 0 })
    await journal.appendItem(codexItem(3), assistantBody('reply to second'), { fence: 0 })

    // Eviction/restart → thread/resume → restoreCodexJournalThread replays the
    // turn's persisted items as history; user messages are NOT suppressed there.
    await journal.appendItem(codexItem(0), promptA, { fence: 0 })
    await journal.appendItem(codexItem(2), promptB, { fence: 0 })

    const userTexts = journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      .map((item) => (item.body.kind === 'message' ? item.body.blocks : []))
      .map((blocks) => blocks.map((block) => ('text' in block ? block.text : '')).join(''))
    expect(userTexts).toEqual(['first prompt', 'second prompt'])
  })

  it('control: the true identity (ordinal 2) for the second send survives the restore', async () => {
    const journal = await journals.open({
      identity: IDENTITY,
      journalDir: root,
      now: tick,
      mintEpoch: () => `epoch-${clock}`
    })
    const promptA = userBody('first prompt')
    const promptB = userBody('second prompt')
    await journal.appendSubmission({
      clientMessageId: 'msg-A',
      payloadFingerprint: fingerprint(promptA),
      body: promptA,
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'msg-A',
      state: 'accepted',
      providerIdentity: codexItem(0),
      fence: 0
    })
    await journal.appendSubmission({
      clientMessageId: 'msg-B',
      payloadFingerprint: fingerprint(promptB),
      body: promptB,
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'msg-B',
      state: 'accepted',
      providerIdentity: codexItem(2),
      fence: 0
    })
    await journal.appendItem(codexItem(1), assistantBody('reply to first'), { fence: 0 })
    await journal.appendItem(codexItem(3), assistantBody('reply to second'), { fence: 0 })
    await journal.appendItem(codexItem(0), promptA, { fence: 0 })
    await journal.appendItem(codexItem(2), promptB, { fence: 0 })

    const userTexts = journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      .map((item) => (item.body.kind === 'message' ? item.body.blocks : []))
      .map((blocks) => blocks.map((block) => ('text' in block ? block.text : '')).join(''))
    expect(userTexts).toEqual(['first prompt', 'second prompt'])
  })
})
