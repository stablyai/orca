import { applyJournalSqlStepCommand } from '../../native-chat/agent-session-journal/journal-sql-step-command'
import * as storedRows from '../../native-chat/agent-session-journal/journal-stored-output-rows'
import { claudeWithSavedHistory } from '../structured/startup/claude-structured-session-open.test-fixture'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, expect, it, vi } from 'vitest'
import { stat, writeFile } from 'node:fs/promises'
import { readJournalSqlPoint } from '../../native-chat/agent-session-journal/journal-sql-point-read'
import { withTestAgentSessionDatabase } from '../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import {
  chat,
  closeClaudeCatchUpChats,
  recoveryReceivedBytes,
  PROVIDER,
  SESSION
} from './claude-transcript-catch-up.test-support'
import '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker.test-fixture'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeClaudeCatchUpChats()
})

it('preserves the typed goal and counters when a decoded reply has the same identity', async () => {
  const c = await chat('batch')
  const identity = { provider: 'claude', sessionId: PROVIDER, uuid: 'old-leaf' } as const
  const goal = {
    objective: 'Ship docs',
    status: 'active',
    tokenBudget: 5000,
    tokensUsed: 812,
    timeUsedSeconds: 42,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_042_000
  } as const
  const body: AgentJournalItemBody = {
    kind: 'status',
    text: 'Goal set: Ship docs',
    threadGoal: { state: 'set', goal }
  }
  await c.journal.appendItem(identity, body, { fence: 1, turnScope: { kind: 'thread' } })
  await writeFile(
    c.filePath,
    [
      JSON.stringify({
        type: 'assistant',
        uuid: 'old-leaf',
        parentUuid: null,
        message: { model: '<synthetic>', content: [{ type: 'text', text: body.text }] }
      }),
      ...Array.from({ length: 1100 }, (_, index) =>
        JSON.stringify({
          type: 'assistant',
          uuid: `new-${index}`,
          parentUuid: index ? `new-${index - 1}` : 'old-leaf',
          message: { content: `Outside answer ${index}` }
        })
      ),
      ''
    ].join('\n')
  )
  expect(
    await catchUpClaudeTranscript({
      sessionId: SESSION,
      providerSessionId: PROVIDER,
      leafUuid: 'old-leaf',
      claudeConfigDir: c.config,
      cwd: c.cwd,
      sink: c.deferred.sink,
      mode: 'recovery'
    })
  ).toBe(true)
  expect(await c.journal.reads.threadGoalSource()).toEqual({
    goal,
    row: { identity, text: body.text }
  })
  expect(await c.journal.reads.itemBody(agentJournalItemKey(identity))).toEqual(body)
  expect((await c.items()).at(-1)?.body).toMatchObject({ presentation: 'continued-outside-recent' })
})

async function seedLargeReceipt(c: Awaited<ReturnType<typeof chat>>) {
  const source = await stat(c.filePath)
  const providerHandle = { kind: 'claude', sessionId: PROVIDER, leafUuid: 'newest-answer' }
  const ids = Array.from(
    { length: 30_000 },
    (_, index) => `1a111111-1111-4111-8111-${String(index).padStart(12, '0')}`
  )
  const annotation = JSON.stringify({
    providerHandle,
    raw: {
      version: 1,
      kind: 'native_copy',
      agent: 'claude',
      unit: 'claude-entry',
      providerHandle,
      ids,
      sourceFrontier: 'newest-answer',
      sourceConsumedBytes: source.size,
      sourceMtimeMs: source.mtimeMs
    }
  })
  await withTestAgentSessionDatabase(c.cwd, (db) =>
    db
      .prepare('UPDATE journal_chat_state SET history_origin_json=? WHERE session_id=?')
      .run(annotation, SESSION)
  )
  return annotation
}

// PR #45200: a normal batch only needs the public cursor, independent of receipt size.
it('commits a general step batch without parsing the saved receipt', async () => {
  const c = await chat('batch')
  const receipt = await seedLargeReceipt(c)
  const { epoch } = await c.journal.reads.physicalCursor()
  await withTestAgentSessionDatabase(c.cwd, (db) => {
    db.exec('BEGIN')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const result = applyJournalSqlStepCommand(
        db,
        c.cwd,
        {
          target: { sessionId: SESSION, epoch, ownerToken: 'owner' },
          operation: {
            kind: 'steps',
            steps: [
              {
                kind: 'item',
                identity: { provider: 'claude', sessionId: PROVIDER, uuid: 'after-copy' },
                body: {
                  kind: 'message',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'After recovery' }]
                },
                options: { fence: 1, turnScope: { kind: 'thread' } },
                reservedBytes: 2048
              }
            ]
          }
        },
        1_800_000_000_000
      )
      expect(result.items[0]?.itemId).toBe(`claude:${PROVIDER}:after-copy`)
      expect(parse.mock.calls.filter(([input]) => input === receipt)).toHaveLength(0)
    } finally {
      parse.mockRestore()
      db.exec('ROLLBACK')
    }
  })
})

// PR #45200: an unchanged open with a 30,000-ID receipt transfers only its header.
it('opens a leafless Claude chat without receiving its full coverage receipt', async () => {
  const c = await chat('batch')
  await seedLargeReceipt(c)
  await c.reopen()
  const { adapter } = claudeWithSavedHistory({
    providerSessionId: PROVIDER,
    cwd: c.cwd,
    claudeConfigDir: c.config,
    leafless: true
  })
  try {
    const messages = recoveryReceivedBytes()
    const acquired = await adapter.acquire({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle(PROVIDER, null)
      },
      fence: 1,
      spawnToken: 'large-receipt-open',
      events: c.deferred.sink
    })
    await expect(
      adapter.open({
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ newConversation: false })
    expect(messages.length).toBeGreaterThan(0)
    expect(Math.max(...messages)).toBeLessThanOrEqual(512 * 1024)
  } finally {
    await adapter.closeAll()
  }
})

const envelopeCases = [
  { name: 'ASCII Write input', text: 'w'.repeat(524_095), tool: true },
  { name: 'ASCII answer', text: 'r'.repeat(524_104), tool: false },
  { name: 'two-byte answer', text: '中'.repeat(262_052), tool: false }
]

it.each(envelopeCases)(
  'restores a saved $name at the reply envelope boundary',
  async ({ text, tool }) => {
    const c = await chat('batch')
    const identity = { provider: 'claude', sessionId: PROVIDER, uuid: 'envelope-answer' } as const
    const input = { content: text }
    const body: AgentJournalItemBody = tool
      ? { kind: 'tool-call', callId: 'write', name: 'Write', state: 'completed', input }
      : { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
    await c.journal.appendItem(identity, body, { fence: 1, turnScope: { kind: 'thread' } })
    await writeFile(
      c.filePath,
      [
        JSON.stringify({
          type: 'assistant',
          uuid: identity.uuid,
          parentUuid: 'old-leaf',
          message: {
            content: tool ? [{ type: 'tool_use', id: 'write', name: 'Write', input }] : text
          }
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'frontier',
          parentUuid: identity.uuid,
          message: { content: 'New answer' }
        }),
        ''
      ].join('\n')
    )
    const args = {
      sessionId: SESSION,
      providerSessionId: PROVIDER,
      leafUuid: 'old-leaf',
      claudeConfigDir: c.config,
      cwd: c.cwd,
      sink: c.deferred.sink,
      maxBytes: 64 * 1024
    }
    expect(await catchUpClaudeTranscript(args)).toMatchObject({ kind: 'capacity' })
    const messages = recoveryReceivedBytes()
    expect(
      await catchUpClaudeTranscript({ ...args, mode: 'recovery', maxBytes: 2 * 1024 * 1024 })
    ).toBe(true)
    expect(Math.max(...messages)).toBeLessThanOrEqual(512 * 1024)
    await c.reopen()
    expect(await catchUpClaudeTranscript(args)).toBe(true)
    expect(await c.journal.reads.itemBody(agentJournalItemKey(identity))).toEqual(body)
  }
)

// PR #45200: a multi-slice row is decoded only once per transfer.
it('does one stored row decode for a multi-page saved field transfer', async () => {
  const c = await chat('batch')
  const text = '中'.repeat(700_000)
  const identity = { provider: 'claude', sessionId: PROVIDER, uuid: 'large-answer' } as const
  await c.journal.appendItem(
    identity,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text }]
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const { epoch } = await c.journal.reads.physicalCursor()
  const key = agentJournalItemKey(identity)
  const revision = (await c.journal.reads.item(key))!.revision
  await withTestAgentSessionDatabase(c.cwd, (db) => {
    const parse = vi.spyOn(storedRows, 'readJournalStoredItem')
    const first = { ordinal: 0, offset: 0 }
    let after: typeof first | null = first
    let pages = 0
    while (after) {
      const result = readJournalSqlPoint(db, {
        sessionId: SESSION,
        operation: {
          kind: 'claude-recovery-slices',
          transferId: 'test-transfer',
          epoch,
          key,
          canonicalItemId: key,
          revision,
          after,
          fields: [{ kind: 'text', blockIndex: 0 }]
        }
      })
      if (result.kind !== 'claude-recovery-slices') {
        throw new Error('Expected saved fragments.')
      }
      after = result.next
      pages++
    }
    expect(pages).toBeGreaterThan(2)
    expect(parse).toHaveBeenCalledTimes(1)
  })
})
