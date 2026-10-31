import { mkdtemp, rm, writeFile, readFile, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeCodexHistoryFixture } from '../agent-session-journal/codex-history-test-fixture'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript
} from './structured-agent-session-switch-import'

vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
const journals = createTrackedJournalOpener()
let root: string
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-switch-import-'))
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
function options() {
  return {
    stateDirectory: root,
    identity: {
      sessionId: 'native',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('019aef12-1234-7000-8000-123456789abc')
    }
  }
}
const claudeRecording = await readFile(
  join(import.meta.dirname, '__fixtures__', 'claude-cli-switch-2.1.302.jsonl'),
  'utf8'
)
const claudeRecordingId: string = JSON.parse(claudeRecording.split('\n')[0]!).sessionId
/** The production refresh: Codex's resting import (its one turn-record writer), then the shared one. */
async function refresh(input: Parameters<typeof catchUpSwitchedCliTranscript>[0]) {
  if (input.source.agent === 'codex') {
    await catchUpStructuredSessionAtRest({
      journal: input.journal,
      threadId: input.source.sessionId,
      filePath: input.source.filePath,
      fence: input.fence,
      deadline: input.deadline,
      stoppedTurnId: input.stopped?.turnId,
      stoppedUserItemKey: input.stopped?.userItemKey,
      settleAbandoned: input.settleAbandoned
    })
  }
  await catchUpSwitchedCliTranscript(input)
}
it.each([
  ['claude', claudeRecordingId],
  ['codex', '01a183db-b8d6-7170-af39-e004651c1e1e'],
  ['pi', '01a1841b-2daa-7238-ade8-4b2474dcac14'],
  ['grok', '01a105db-937d-7ec0-b1d1-5396ae618abf'],
  ['opencode', 'ses_e7afa14d9ffernpe5xoa3e21SL'],
  ['opencode2', 'ses_e7bc5544cffeP7rTuOdvcklM2n']
] as const)(
  'settles recorded %s storage durably without replacing native completion or duplicating imported tools',
  async (agent, recordedId) => {
    const fixtures = join(import.meta.dirname, '__fixtures__', 'recorded-native-switch', agent)
    const sqlite = agent === 'opencode' || agent === 'opencode2'
    const filePath = join(root, sqlite ? 'native.db' : 'native.jsonl')
    const source = { agent, sessionId: agent === 'pi' ? filePath : recordedId, filePath }
    async function install(completed: boolean) {
      if (agent === 'claude') {
        const rows = claudeRecording.trimEnd().split('\n')
        expect(rows).toHaveLength(4)
        // Fixture truncation at genuine tool use, not a recording of Stop or exit.
        await writeFile(filePath, completed ? claudeRecording : `${rows.slice(0, 2).join('\n')}\n`)
      } else if (agent === 'grok') {
        const directory = join(fixtures, completed ? 'completed' : 'interrupted-prefix')
        await copyFile(join(directory, 'chat_history.jsonl'), filePath)
        await copyFile(join(directory, 'events.jsonl'), join(root, 'events.jsonl'))
      } else if (agent === 'pi') {
        const recording = await readFile(join(fixtures, 'completed.jsonl'), 'utf8')
        const rows = recording.trimEnd().split('\n')
        expect(JSON.parse(rows[0]!).id).toBe(recordedId)
        expect(source.sessionId).not.toBe(recordedId)
        // Fixture truncation at a genuine tool result; no captured Stop or physical exit.
        await writeFile(filePath, completed ? recording : `${rows.slice(0, 6).join('\n')}\n`)
      } else {
        await copyFile(
          join(
            fixtures,
            `${completed ? 'completed' : 'recorded-prefix'}.${sqlite ? 'db' : 'jsonl'}`
          ),
          filePath
        )
      }
    }
    const recordedOptions = {
      ...options(),
      identity: {
        ...options().identity,
        agent,
        providerHandle:
          agent === 'codex'
            ? codexProviderHandle(recordedId)
            : agent === 'claude'
              ? claudeProviderHandle(recordedId, null)
              : null
      }
    }
    async function imported(sessionId: string) {
      const journal = await journals.open({
        ...recordedOptions,
        identity: { ...recordedOptions.identity, sessionId }
      })
      const result = await importLegacyTranscriptIntoJournal({
        journal,
        agent,
        sessionId: source.sessionId,
        fence: 1,
        options: { filePath }
      })
      expect(result).toMatchObject({ ok: true, replaced: true })
      return journal
    }
    const turns = (journal: AgentSessionJournal) =>
      journal.snapshot().items.flatMap(({ body }) => (body.kind === 'turn' ? [body] : []))
    const blocks = (journal: AgentSessionJournal) =>
      journal
        .snapshot()
        .items.flatMap(({ body }) =>
          body.kind === 'message'
            ? body.blocks.map((block) => block.type)
            : body.kind === 'tool-call'
              ? ['tool-call']
              : []
        )
    await install(false)
    const historical = await imported('historical-recording')
    await refresh({ journal: historical, source, fence: 1, deadline })
    expect(turns(historical)).toEqual([])
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped).toMatchObject({ sessionId: source.sessionId })
    let journal = await imported('switched-recording')
    const content = journal.snapshot().items
    expect(
      content.filter(({ body }) => body.kind === 'message' && body.role === 'user')
    ).toHaveLength(1)
    expect(blocks(journal)).toContain('tool-call')
    await refresh({ journal, source, fence: 1, deadline, stopped })
    expect(turns(journal)).toEqual([
      expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
    ])
    expect(journal.snapshot().items.filter(({ body }) => body.kind !== 'turn')).toEqual(content)
    const interrupted = journal.snapshot()
    const [turn] = turns(journal)
    const verdict = agentTurnVerdict({ state: turn!.state, outcome: turn!.outcome ?? null })
    expect(verdict).toBe('cancellation')
    expect(
      agentVerdictDisplayMark({
        state: 'done',
        mainAgent: { state: 'done', outcome: verdict ?? undefined }
      })
    ).toBe('interrupted')
    expect(withNativeChatCutTurnNotices(interrupted.items)).toBe(interrupted.items)
    await journal.close()
    journal = await journals.open({
      ...recordedOptions,
      identity: { ...recordedOptions.identity, sessionId: 'switched-recording' }
    })
    await refresh({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot()).toEqual(interrupted)
    if (agent === 'claude') {
      const prefix = await readFile(filePath, 'utf8')
      const assistant = JSON.parse(prefix.trimEnd().split('\n').at(-1)!)
      expect(typeof assistant.uuid).toBe('string')
      await writeFile(
        filePath,
        `${prefix}${JSON.stringify({
          type: 'user',
          uuid: 'interrupted-cli-turn',
          sessionId: recordedId,
          interruptedMessageId: assistant.uuid,
          timestamp: new Date(Date.parse(assistant.timestamp) + 1).toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: '[Request interrupted by user]' }]
          }
        })}\n`
      )
      const historyWithMarker = await imported('historical-interruption-marker')
      await refresh({ journal: historyWithMarker, source, fence: 1, deadline })
      const [historicalTurn] = turns(historyWithMarker)
      // Claude's own interruption notice is the user's Stop, with or without this switch's proof.
      expect(historicalTurn).toMatchObject({
        state: 'interrupted',
        turnId: stopped!.turnId,
        outcome: 'cancellation'
      })
      const historyItems = historyWithMarker.snapshot().items
      expect(withNativeChatCutTurnNotices(historyItems)).toBe(historyItems)
      const stoppedWithMarker = await imported('stopped-interruption-marker')
      await refresh({
        journal: stoppedWithMarker,
        source,
        fence: 1,
        deadline,
        stopped
      })
      expect(turns(stoppedWithMarker)).toEqual([
        expect.objectContaining({
          state: 'interrupted',
          turnId: stopped!.turnId,
          outcome: 'cancellation'
        })
      ])
      const stoppedItems = stoppedWithMarker.snapshot().items
      expect(withNativeChatCutTurnNotices(stoppedItems)).toBe(stoppedItems)
      const stoppedSnapshot = stoppedWithMarker.snapshot()
      await refresh({
        journal: stoppedWithMarker,
        source,
        fence: 1,
        deadline,
        stopped
      })
      expect(stoppedWithMarker.snapshot()).toEqual(stoppedSnapshot)
    }
    if (agent === 'codex') {
      const prefix = await readFile(filePath, 'utf8')
      const started = prefix
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((row) => row.type === 'event_msg' && row.payload.type === 'task_started')
      expect(started.payload.turn_id).toBe(stopped!.turnId)
      await writeFile(
        filePath,
        `${prefix}${JSON.stringify({
          type: 'event_msg',
          timestamp: new Date(Date.parse(started.timestamp) + 1).toISOString(),
          payload: { type: 'turn_aborted', turn_id: stopped!.turnId }
        })}\n`
      )
      const canonicalTurn = agentJournalItemKey({
        provider: 'legacy',
        agent,
        sessionId: recordedId,
        recordId: `turn-lifecycle:${stopped!.turnId}`
      })
      for (const personalStop of [false, true]) {
        const nativeOptions = {
          ...recordedOptions,
          identity: {
            ...recordedOptions.identity,
            sessionId: personalStop ? 'at-rest-stopped' : 'at-rest-historical'
          }
        }
        let retained = await journals.open(nativeOptions)
        await retained.appendItem(
          { provider: 'codex', threadId: recordedId, turnId: 'prior-native-turn', ordinal: 0 },
          { kind: 'turn', turnId: 'prior-native-turn', state: 'completed', outcome: 'success' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        const nativeItems = retained.snapshot().items
        expect(turns(retained)).toHaveLength(1)
        expect(retained.item(canonicalTurn)).toBeNull()
        await catchUpStructuredSessionAtRest({
          journal: retained,
          threadId: recordedId,
          filePath,
          fence: 1,
          deadline,
          stoppedTurnId: personalStop ? stopped!.turnId : undefined,
          check: deadline.check
        })
        const firstEnd = retained.item(canonicalTurn)
        expect(firstEnd?.body).toEqual({
          kind: 'turn',
          turnId: stopped!.turnId,
          state: 'interrupted',
          ...(personalStop ? { outcome: 'cancellation' } : {}),
          completedAt: Date.parse(started.timestamp) + 1
        })
        expect(retained.snapshot().items.slice(0, nativeItems.length)).toEqual(nativeItems)
        await refresh({
          journal: retained,
          source,
          fence: 1,
          deadline,
          stopped: personalStop ? stopped : undefined
        })
        expect(retained.item(canonicalTurn)).toEqual(firstEnd)
        const ended = turns(retained).at(-1)!
        const verdict = agentTurnVerdict({ state: ended.state, outcome: ended.outcome ?? null })
        expect(verdict).toBe(personalStop ? 'cancellation' : 'interruption')
        expect(
          agentVerdictDisplayMark({
            state: 'done',
            mainAgent: { state: 'done', outcome: verdict! }
          })
        ).toBe(personalStop ? 'interrupted' : 'failed')
        const snapshot = retained.snapshot()
        if (personalStop) {
          expect(withNativeChatCutTurnNotices(snapshot.items)).toBe(snapshot.items)
        } else {
          expect(withNativeChatCutTurnNotices(snapshot.items)).toHaveLength(
            snapshot.items.length + 1
          )
        }
        await retained.close()
        retained = await journals.open(nativeOptions)
        await catchUpStructuredSessionAtRest({
          journal: retained,
          threadId: recordedId,
          filePath,
          fence: 1,
          deadline,
          stoppedTurnId: stopped!.turnId,
          check: deadline.check
        })
        await refresh({
          journal: retained,
          source,
          fence: 1,
          deadline,
          stopped
        })
        expect(retained.canonicalItemId(canonicalTurn)).toBe(canonicalTurn)
        if (personalStop) {
          expect(retained.snapshot()).toEqual(snapshot)
        } else {
          // A proven stop explains the interruption an earlier import saved without a verdict.
          expect(retained.item(canonicalTurn)?.body).toEqual({
            ...firstEnd!.body,
            outcome: 'cancellation'
          })
          expect(retained.snapshot().items.filter(({ body }) => body.kind !== 'turn')).toEqual(
            snapshot.items.filter(({ body }) => body.kind !== 'turn')
          )
        }
      }
    }
    await install(true)
    const completed = await imported('completed-recording')
    await refresh({ journal: completed, source, fence: 1, deadline, stopped })
    expect(turns(completed)).toEqual([expect.objectContaining({ state: 'completed' })])
    expect(blocks(completed)).toContain('tool-result')
    const final = completed.snapshot()
    await refresh({ journal: completed, source, fence: 1, deadline, stopped })
    expect(completed.snapshot()).toEqual(final)
  }
)

it.each(['adopted-active', 'retained-archive'] as const)(
  'keeps account-qualified paginated ancestry through capture and final refresh: %s',
  async (route) => {
    const sessions = join(root, 'account', 'sessions')
    const archive = join(root, 'account', 'archived_sessions')
    await mkdir(sessions, { recursive: true })
    await mkdir(archive)
    const parentId = '01a17c7f-6f58-7a73-b87a-a8702ff2da17'
    const childId = '01a17c81-30d1-72f0-b84e-002ddfe6fd47'
    const parent = await writeCodexHistoryFixture(
      route === 'retained-archive' ? archive : sessions,
      parentId,
      ['prior completed']
    )
    const child = await writeCodexHistoryFixture(sessions, childId, ['current'], parent.position)
    const source = {
      agent: 'codex' as const,
      sessionId: childId,
      filePath: child.filePath,
      ...(route === 'adopted-active'
        ? {
            source: { providerSessionId: childId, workspaceCwd: root, conversationStore: sessions }
          }
        : { codexHome: join(root, 'account') })
    }
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped).toMatchObject({ sessionId: childId })
    const journal = await journals.open({
      ...options(),
      identity: { ...options().identity, providerHandle: codexProviderHandle(childId) }
    })
    expect(
      await importLegacyTranscriptIntoJournal({
        journal,
        agent: 'codex',
        sessionId: childId,
        fence: 1,
        options: { filePath: child.filePath, codexSessionsDirs: [sessions] }
      })
    ).toMatchObject({ ok: true, replaced: true })
    const messages = journal.snapshot().items
    expect(
      messages.filter(({ body }) => body.kind === 'message').map(({ body }) => body)
    ).toMatchObject([
      { blocks: [{ text: 'prior completed' }] },
      { blocks: [{ text: 'prior completed answer' }] },
      { blocks: [{ text: 'current' }] },
      { blocks: [{ text: 'current answer' }] }
    ])
    await refresh({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot().items.filter(({ body }) => body.kind !== 'turn')).toEqual(messages)
    expect(
      journal
        .snapshot()
        .items.filter(({ body }) => body.kind === 'turn')
        .map(({ body }) => body)
    ).toEqual([expect.objectContaining({ state: 'interrupted', turnId: stopped!.turnId })])
    const refreshed = journal.snapshot()
    await refresh({ journal, source, fence: 1, deadline })
    expect(journal.snapshot()).toEqual(refreshed)
    await expect(
      captureSwitchStoppedCliTurn(
        {
          ...source,
          source: undefined,
          codexHome: join(root, 'wrong-account')
        },
        true,
        deadline
      )
    ).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_identity_required',
        details: { reason: 'transcriptUnreadable' }
      }
    })
  }
)
