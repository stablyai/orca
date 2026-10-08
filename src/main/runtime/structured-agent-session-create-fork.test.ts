import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { resolveStructuredAgentSessionForkForCreate } from './structured-agent-session-create-fork'

const PARENT = 'claude_parent_chat'
const CHILD = 'claude_forked_chat'
const TURN = 'legacy:claude:provider:turn-lifecycle:turn-1'
const ANSWER = 'claude:provider:answer-1'

function row(itemId: string, body: unknown, turnItemId?: string): AgentJournalRenderItem {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only a row's id, body and turn scope.
  return {
    itemId,
    body,
    ...(turnItemId ? { turnScope: { kind: 'turn', turnItemId } } : {})
  } as AgentJournalRenderItem
}

/** A parent chat with one turn and the answer row a person would fork from. */
function journal(turn: Record<string, unknown>): AgentJournalRenderItem[] {
  return [
    row(TURN, { kind: 'turn', turnId: 'turn-1', ...turn }),
    row(ANSWER, { kind: 'message', role: 'assistant', blocks: [] }, TURN)
  ]
}

const FINISHED = { state: 'completed', outcome: 'success' }

function hostWith(
  records: AgentSessionRecord[],
  items: AgentJournalRenderItem[]
): StructuredAgentSessionHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolving a fork reads only the record store and rows of one journal.
  return {
    deps: {
      store: { getRecord: (id: string) => records.find((r) => r.sessionId === id) ?? null }
    },
    journalItem: async (_sessionId: string, itemId: string) =>
      items.find((item) => item.itemId === itemId) ?? null
  } as unknown as StructuredAgentSessionHost
}

function parentRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return { ...agentSessionRecordFixture(), sessionId: PARENT, ...overrides }
}

function resolve(host: StructuredAgentSessionHost, agent: 'claude' | 'codex' = 'claude') {
  return resolveStructuredAgentSessionForkForCreate({
    host,
    agent,
    forkFrom: { sessionId: PARENT, itemId: ANSWER },
    selfSessionId: CHILD,
    location: agentSessionRecordFixture().location
  })
}

async function refusalOf(attempt: Promise<unknown>): Promise<string> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught
  )
  return isAgentSessionRefusalError(error) ? error.refusal.code : `not refused: ${String(error)}`
}

describe('what a forking create attaches with', () => {
  it('records where Claude cuts the copy, in the parent account, and copies nothing yet', async () => {
    const accountHome = { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/user/.claude-work' }
    const parent = parentRecord({ accountHome, options: { model: 'opus' } })

    const fork = await resolve(hostWith([parent], journal({ ...FINISHED, forkPoint: 'leaf-1' })))

    expect(fork).toEqual({
      forkedFrom: {
        sessionId: PARENT,
        itemId: ANSWER,
        providerSessionId: 'provider-session-alpha-1',
        forkPoint: 'leaf-1'
      },
      accountHome,
      options: { model: 'opus' }
    })
  })

  it('cuts a Codex copy at the turn’s own id', async () => {
    const parent = parentRecord({
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
      providerHandleChain: [
        {
          linkId: 'link-1',
          origin: 'created',
          mintedAtFence: 7,
          observedAt: 1,
          handle: codexProviderHandle('thread-parent')
        }
      ]
    })

    const fork = await resolve(hostWith([parent], journal(FINISHED)), 'codex')

    expect(fork).toEqual({
      forkedFrom: {
        sessionId: PARENT,
        itemId: ANSWER,
        providerSessionId: 'thread-parent',
        forkPoint: 'turn-1'
      },
      accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' }
    })
  })

  it('answers a retry from the record it already reserved, whatever became of the parent', async () => {
    const forkedFrom = {
      sessionId: PARENT,
      itemId: ANSWER,
      providerSessionId: 'provider-session-alpha-1',
      forkPoint: 'leaf-1'
    }
    const committed: AgentSessionRecord = {
      ...agentSessionRecordFixture(),
      sessionId: CHILD,
      options: { model: 'opus' },
      forkedFrom
    }

    const fork = await resolve(hostWith([committed], []))

    expect(fork).toEqual({
      forkedFrom,
      accountHome: committed.accountHome,
      options: { model: 'opus' }
    })
  })

  it.each([
    ['is still running', { state: 'running' }],
    ['was stopped', { state: 'interrupted', outcome: 'cancellation', forkPoint: 'leaf-1' }],
    ['failed', { state: 'completed', outcome: 'failure', forkPoint: 'leaf-1' }],
    ['ended where this host recorded no cut', FINISHED]
  ])('refuses a Claude turn that %s', async (_, turn) => {
    const refusal = await refusalOf(resolve(hostWith([parentRecord()], journal(turn))))

    expect(refusal).toBe('agent_session_operation_invalid')
  })

  it('refuses a row the chat no longer has', async () => {
    expect(await refusalOf(resolve(hostWith([parentRecord()], [])))).toBe(
      'agent_session_operation_invalid'
    )
  })

  it('refuses a chat this host holds no record of', async () => {
    expect(await refusalOf(resolve(hostWith([], [])))).toBe('agent_session_identity_required')
  })

  it('refuses to open the copy as another agent or in another workspace', async () => {
    const finished = journal({ ...FINISHED, forkPoint: 'leaf-1' })
    const elsewhere = parentRecord({
      location: { ...agentSessionRecordFixture().location, workspaceId: 'workspace-2' }
    })

    expect(await refusalOf(resolve(hostWith([parentRecord()], finished), 'codex'))).toBe(
      'agent_session_operation_invalid'
    )
    expect(await refusalOf(resolve(hostWith([elsewhere], finished)))).toBe(
      'agent_session_operation_invalid'
    )
  })

  it('does not hand a committed fork of one turn to a create that names another', async () => {
    const committed: AgentSessionRecord = {
      ...agentSessionRecordFixture(),
      sessionId: CHILD,
      forkedFrom: {
        sessionId: PARENT,
        itemId: 'claude:provider:another-answer',
        providerSessionId: 'provider-session-alpha-1',
        forkPoint: 'leaf-0'
      }
    }

    // Falls through to the parent, which this host no longer holds.
    expect(await refusalOf(resolve(hostWith([committed], [])))).toBe(
      'agent_session_identity_required'
    )
  })
})
