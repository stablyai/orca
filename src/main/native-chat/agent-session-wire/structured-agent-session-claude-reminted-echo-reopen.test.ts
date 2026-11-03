import { expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { markJournalPendingSubmissionsUnknown } from '../agent-session-journal/journal-pending-submission-recovery'
import { ClaudeStructuredSessionAdapter } from '../../claude/structured/claude-structured-session-adapter'
import {
  fakeClaude,
  claudeFrame,
  type FakeConnection
} from '../../claude/structured/claude-structured-session-test-support'
import { claudeStartupSettled } from '../../claude/structured/claude-structured-startup-settled-test-support'
import {
  chat,
  SESSION,
  SID,
  chatTurn,
  prompt,
  reply,
  attachment
} from '../../claude/claude-transcript-catch-up-test-support'

function frame(connection: FakeConnection, message: Record<string, unknown>) {
  claudeFrame(connection, { ...message, session_id: SID })
}

it('reopens the disk journal before joined echoes without reviving delivery authority or resending', async () => {
  const c = await chat()
  await c.live()
  const claude = fakeClaude({ initSessionId: SID, replayUuid: null })
  const settled = vi.fn()
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work',
      claudeConfigDir: '/unused-test-home',
      providerSessionId: SID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false,
      cliFlag: async () => 'supported' as const
    }),
    onEvent: () => {},
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_000,
    now: () => 4_000,
    onDispatchSettledLate: settled
  })
  try {
    await adapter.acquire({
      identity: c.identity,
      fence: 1,
      spawnToken: 'before-restart',
      events: c.deferred.sink
    })
    await claudeStartupSettled(adapter, SESSION)
    const connection = claude.connections[0]!
    for (const [id, text] of [
      ['pending-a', 'first unacknowledged'],
      ['pending-b', 'joined unacknowledged']
    ] as const) {
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text }]
      }
      await c.journal.appendSubmission({
        clientMessageId: id!,
        body,
        payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
        fence: 1,
        handoverRecorded: true
      })
      expect(
        await adapter.dispatch({ sessionId: SESSION, clientMessageId: id!, body, fence: 1 })
      ).toMatchObject({ state: 'admitted' })
      if (id === 'pending-a') {
        frame(connection, {
          type: 'command_lifecycle',
          state: 'started',
          command_uuid: connection.sent[0]!.uuid
        })
        frame(connection, {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          uuid: 'pre-echo-owner'
        })
      }
    }
    const priorGeneration = adapter['sessions'].get(SESSION)!.acquisitionGeneration
    expect(adapter['sessions'].get(SESSION)!.dispatchWaiters).toHaveLength(2)
    await c.deferred.drained()
    const opened = c.journal
      .snapshot()
      .items.find((item) => readAgentJournalTurn(item.body)?.turnId === 'pre-echo-owner')!
    expect(readAgentJournalTurn(opened.body)).toMatchObject({ state: 'running' })
    await adapter.releaseAcquisition({ sessionId: SESSION })
    await c.deferred.drained()
    await markJournalPendingSubmissionsUnknown(c.journal, 1)
    const saved = c.journal.snapshot()
    await c.journal.close()
    const reopened = await c.replay()
    c.deferred.bind({ journal: reopened, fence: 2, publish: () => {} })
    expect(reopened.snapshot()).toEqual(saved)
    await adapter.acquire({
      identity: c.identity,
      fence: 2,
      spawnToken: 'after-restart',
      events: c.deferred.sink
    })
    await claudeStartupSettled(adapter, SESSION)
    const fresh = adapter['sessions'].get(SESSION)!
    expect(fresh.acquisitionGeneration).not.toBe(priorGeneration)
    expect(fresh.dispatchWaiters).toEqual([])
    expect(fresh.retiredDispatchWaiters).toEqual([])
    expect(claude.connections[1]!.sent).toEqual([])
    // Equal old content in a new acquisition is not proof of either pending input's delivery.
    frame(claude.connections[1]!, {
      type: 'user',
      uuid: 'late-remint',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'joined unacknowledged' }] }
    })
    await c.deferred.drained()
    expect(settled).not.toHaveBeenCalled()
    expect(reopened.snapshot().submissions).toEqual(saved.submissions)
    expect(reopened.receiptFor('pending-a')).toBeNull()
    expect(reopened.receiptFor('pending-b')).toBeNull()
    expect(
      reopened
        .snapshot()
        .items.filter((item) => readAgentJournalTurn(item.body)?.state === 'running')
    ).toEqual([])

    // Import keeps a queued attachment in its saved span and a physical input as a real boundary.
    await c.write([
      ...chatTurn,
      {
        ...attachment('queued-b', 'a1'),
        attachment: {
          type: 'queued_command',
          source_uuid: 'queued-source',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'joined unacknowledged'
        }
      },
      reply(
        'queued-answer',
        'queued-b',
        'msg_queued',
        { type: 'text', text: 'continued answer' },
        5
      ),
      prompt('physical-input', 'queued-answer', 'a physical prompt', 6),
      reply(
        'physical-answer',
        'physical-input',
        'msg_physical',
        { type: 'text', text: 'physical answer' },
        7
      )
    ])
    expect(await c.open('a1')).toBe(true)
    const imported = reopened.snapshot()
    expect(imported.submissions).toEqual(saved.submissions)
    const queuedAnswer = imported.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some((block) => block.type === 'text' && block.text === 'continued answer')
    )!
    const physicalAnswer = imported.items.find(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.some((block) => block.type === 'text' && block.text === 'physical answer')
    )!
    expect(queuedAnswer.turnScope).toBeDefined()
    expect(physicalAnswer.turnScope).not.toEqual(queuedAnswer.turnScope)
    expect(imported.items.find((item) => item.itemId === opened.itemId)).toEqual(
      saved.items.find((item) => item.itemId === opened.itemId)
    )
    expect(await c.open('a1')).toBe(true)
    expect(reopened.snapshot()).toEqual(imported)
    expect(claude.connections[1]!.sent).toEqual([])
  } finally {
    await adapter.closeAll()
    await c.deferred.drained()
  }
})
