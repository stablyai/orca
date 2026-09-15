// The dispatch identity contract: the id persisted with a submission IS the id
// that reaches Claude's wire frame, and it is durable BEFORE that frame is
// written. Delivery can then be decided by identity rather than inferred from
// absence in a content window.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { AgentJournalSubmissionSchema } from '../../shared/agent-session-journal-schemas'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  performSend,
  type AgentSessionTurnContext
} from '../native-chat/agent-session-wire/structured-agent-session-turns'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import { sessionFor, userMessage, userReplayFrame } from './claude-structured-dispatch-test-support'

const journals = createTrackedJournalOpener()

let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dispatch-identity-'))
  journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'provider-session', leafUuid: null }
    },
    journalDir: root
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'deliver me once' }]
}

/** Drives a real journal through `performSend` into the real Claude dispatch,
 *  capturing what actually reached the provider connection. */
async function sendThroughClaude(): Promise<{
  frames: Record<string, unknown>[]
  persistedWhenFrameWasWritten: string | null | undefined
}> {
  const frames: Record<string, unknown>[] = []
  let persistedWhenFrameWasWritten: string | null | undefined
  const send = vi.fn(async (frame: Record<string, unknown>) => {
    // Read the durable row at the instant of the wire write: this is the
    // ordering claim, not just the final value.
    persistedWhenFrameWasWritten = journal.submissions()[0]?.providerWireUuid
    frames.push(frame)
  })
  const session = sessionFor(send)
  const context: AgentSessionTurnContext = {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: {
      dispatch: (input) => dispatchClaudeTurn(session, input)
    } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'caller',
    publish: vi.fn(),
    now: () => 1
  }
  await performSend(context, {
    clientMessageId: 'client-1',
    payloadFingerprint: 'fingerprint',
    body: BODY
  })
  return { frames, persistedWhenFrameWasWritten }
}

describe('claude dispatch identity persistence', () => {
  it('persists the id that reaches the provider frame', async () => {
    const { frames } = await sendThroughClaude()

    expect(frames).toHaveLength(1)
    const wireUuid = frames[0]!.uuid
    expect(typeof wireUuid).toBe('string')
    // The receipt is only worth anything if it names the frame Claude saw.
    expect(journal.submissions()[0]!.providerWireUuid).toBe(wireUuid)
  })

  it('has the id durable before the frame is written', async () => {
    const { frames, persistedWhenFrameWasWritten } = await sendThroughClaude()

    expect(persistedWhenFrameWasWritten).toBe(frames[0]!.uuid)
  })

  it('reopens the journal with the dispatched id intact', async () => {
    const { frames } = await sendThroughClaude()
    await journal.close()
    const reopened = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: 'provider-session', leafUuid: null }
      },
      journalDir: root
    })

    // Surviving a restart is the whole point: this is the read the reattach does.
    expect(reopened.submissions()[0]!.providerWireUuid).toBe(frames[0]!.uuid)
  })

  it('still settles the echo that carries the persisted id', async () => {
    const frames: Record<string, unknown>[] = []
    const send = vi.fn(async (frame: Record<string, unknown>) => {
      frames.push(frame)
    })
    const session = sessionFor(send)
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: BODY,
      providerWireUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'
    })
    await expect(dispatched).resolves.toEqual({ state: 'admitted' })

    // The supplied id goes on the wire unchanged, and echo matching keys on it.
    expect(frames[0]!.uuid).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001')
    expect(session.dispatchWaiters[0]!.sentUuid).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001')
    expect(
      resolveClaudeReplayWaiter(
        session,
        userReplayFrame('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001', 'deliver me once'),
        settled
      )
    ).toBe(true)
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'
      }
    })
  })

  it('still dispatches an internal send that carries no submission', async () => {
    const frames: Record<string, unknown>[] = []
    const send = vi.fn(async (frame: Record<string, unknown>) => {
      frames.push(frame)
    })
    const session = sessionFor(send)

    await expect(
      dispatchClaudeTurn(session, { body: userMessage([{ type: 'text', text: '/compact' }]) })
    ).resolves.toEqual({ state: 'admitted' })
    expect(typeof frames[0]!.uuid).toBe('string')
  })
})

describe('submission rows written before the field existed', () => {
  it('parses and projects a missing id as null, never undefined', () => {
    // A v2 submission row exactly as an older build wrote it: no such key.
    const legacy = {
      v: 2,
      kind: 'submission',
      epoch: 'epoch-1',
      seq: 1,
      fence: 1,
      ts: 1_000,
      clientMessageId: 'm-1',
      payloadFingerprint: 'a'.repeat(64),
      providerHandle: { kind: 'claude', sessionId: 'provider-session', leafUuid: null },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'old' }] }
    }
    const parsed = parseJournalRow(JSON.stringify(legacy))
    if (!parsed.ok) {
      throw new Error('a row an older build wrote must stay readable')
    }

    const state = createJournalReducerState('session-1', 'epoch-1')
    applyJournalRow(state, parsed.row)

    // This host read the row, so "none recorded" is a known answer: null.
    expect(renderJournalState(state).submissions[0]!.providerWireUuid).toBeNull()
  })
})

describe('the wire projection of the dispatch identity', () => {
  const base = {
    clientMessageId: 'm-1',
    fence: 1,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }

  it('keeps absent and null distinguishable', () => {
    // An old host omits the key; a current host answers null. Collapsing the two
    // would let "this host never evaluated it" read as "no id was recorded".
    const fromOldHost = AgentJournalSubmissionSchema.parse({ ...base })
    const recordedNone = AgentJournalSubmissionSchema.parse({ ...base, providerWireUuid: null })
    const recorded = AgentJournalSubmissionSchema.parse({ ...base, providerWireUuid: 'wire-1' })

    expect('providerWireUuid' in fromOldHost).toBe(false)
    expect(recordedNone.providerWireUuid).toBeNull()
    expect(recorded.providerWireUuid).toBe('wire-1')
  })
})
