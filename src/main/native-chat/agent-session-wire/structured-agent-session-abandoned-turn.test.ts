import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'
import { catchUpSwitchedCliTranscript } from './structured-agent-session-switch-import'

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

// A Codex terminal a switch stopped before Codex wrote its turn's end (the QA rig's own rollout):
// with nothing left writing, the open turn is over and settles; it never latches the conversation.

const THREAD = '01a18fe0-25a2-71a1-8181-92fabd97d936'
const STOPPED_TURN = '01a18fe1-4b7c-75a0-a33d-98196775537d'
const recording = (
  await readFile(
    join(import.meta.dirname, '__fixtures__', 'codex-switch-stopped-before-boundary.jsonl'),
    'utf8'
  )
)
  .trimEnd()
  .split('\n')
// Rows 0–12 hold two finished turns; 13–16 the turn the switch stopped (no end event).
const FINISHED = 13

const journals = createTrackedJournalOpener()
let root: string
let filePath: string
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-abandoned-turn-'))
  filePath = join(root, 'rollout.jsonl')
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(sessionId: string) {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    }
  })
}

/** Rows written after the chat's import carry times after it. */
function later(rows: string[]): string[] {
  // Any time after the import's own (written at the run's real time) will do.
  const at = Date.parse('2999-01-01T00:00:00Z')
  return rows.map((row, index) => {
    const parsed = JSON.parse(row)
    return JSON.stringify({ ...parsed, timestamp: new Date(at + index).toISOString() })
  })
}

async function writeRows(rows: string[]) {
  await writeFile(filePath, `${rows.join('\n')}\n`)
}

function atRest(
  journal: AgentSessionJournal,
  extra: { settleAbandoned?: boolean; stopped?: true }
) {
  return catchUpStructuredSessionAtRest({
    journal,
    threadId: THREAD,
    filePath,
    fence: 1,
    deadline,
    settleAbandoned: extra.settleAbandoned,
    ...(extra.stopped ? { stoppedTurnId: STOPPED_TURN } : {})
  })
}

const turnKey = (turnId: string) =>
  agentJournalItemKey({
    provider: 'legacy',
    agent: 'codex',
    sessionId: THREAD,
    recordId: `turn-lifecycle:${turnId}`
  })

const turns = (journal: AgentSessionJournal) =>
  journal.snapshot().items.flatMap(({ body }) => (body.kind === 'turn' ? [body] : []))

/** A chat that imported the first two turns, then the terminal ran a third that was stopped. */
async function retainedChat(sessionId: string) {
  await writeRows(recording.slice(0, FINISHED))
  const journal = await open(sessionId)
  await importLegacyTranscriptIntoJournal({
    journal,
    agent: 'codex',
    sessionId: THREAD,
    fence: 1,
    options: { filePath }
  })
  await atRest(journal, {})
  await writeRows([...recording.slice(0, FINISHED), ...later(recording.slice(FINISHED))])
  return journal
}

describe('a Codex turn a switch stopped before Codex recorded its end', () => {
  it('refuses while a writer may remain, and settles once nothing can write it', async () => {
    const journal = await retainedChat('retained')
    await expect(atRest(journal, {})).rejects.toMatchObject({
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    expect(journal.item(turnKey(STOPPED_TURN))).toBeNull()

    await atRest(journal, { settleAbandoned: true })
    // The stopped turn's prompt arrived, is that turn's row, and its record names it.
    const prompt = journal
      .snapshot()
      .items.find(
        ({ body, turnScope }) =>
          body.kind === 'message' &&
          body.role === 'user' &&
          turnScope?.kind === 'turn' &&
          turnScope.turnItemId === turnKey(STOPPED_TURN)
      )
    expect(prompt).toBeDefined()
    expect(journal.item(turnKey(STOPPED_TURN))?.body).toEqual({
      kind: 'turn',
      turnId: STOPPED_TURN,
      state: 'interrupted',
      userItemId: prompt?.itemId
    })
    const settled = journal.snapshot()

    // After a restart (or a retry from Session History) nothing latches and nothing repeats.
    await journal.close()
    const reopened = await open('retained')
    await atRest(reopened, { settleAbandoned: true })
    expect(reopened.snapshot()).toEqual(settled)
  })

  it('takes a real end and the rest of the turn when they arrive after the settle', async () => {
    const journal = await retainedChat('healed')
    await atRest(journal, { settleAbandoned: true })
    const settledRows = journal.snapshot().items.length
    const tail = later([
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: STOPPED_TURN,
          item: {
            type: 'AgentMessage',
            id: 'late-answer',
            content: [{ type: 'Text', text: 'written before the end' }]
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'turn_aborted', turn_id: STOPPED_TURN }
      }),
      // A later turn is already there too: the earlier turn still heals.
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'later-turn' }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'later-turn' }
      })
    ])
    await writeRows([...recording.slice(0, FINISHED), ...later(recording.slice(FINISHED)), ...tail])

    await atRest(journal, { settleAbandoned: true })

    const healed = journal.item(turnKey(STOPPED_TURN))?.body
    expect(healed).toMatchObject({ state: 'interrupted', completedAt: expect.any(Number) })
    expect(journal.item(turnKey('later-turn'))?.body).toMatchObject({ state: 'completed' })
    expect(
      journal
        .snapshot()
        .items.some(
          ({ body }) =>
            body.kind === 'message' &&
            body.blocks.some(
              (block) => block.type === 'text' && block.text.includes('before the end')
            )
        )
    ).toBe(true)
    // The late answer and the later turn's record; the healed record replaces the settled one.
    expect(journal.snapshot().items.length).toBe(settledRows + 2)
  })

  it.each([
    ['stopped by this switch, no end recorded', false, true],
    ['stopped by this switch, end recorded', true, true],
    ['reopened from history after a restart', false, false]
  ])(
    'anchors a first adopted conversation’s last turn to its saved prompt: %s',
    async (_name, ended, stopped) => {
      await writeRows([
        ...recording,
        ...(ended
          ? [
              JSON.stringify({
                timestamp: '2026-10-31T02:54:41.000Z',
                type: 'event_msg',
                payload: { type: 'turn_aborted', turn_id: STOPPED_TURN }
              })
            ]
          : [])
      ])
      const journal = await open(`adopted-${String(ended)}-${String(stopped)}`)
      await importLegacyTranscriptIntoJournal({
        journal,
        agent: 'codex',
        sessionId: THREAD,
        fence: 1,
        options: { filePath }
      })
      const imported = journal.snapshot().items

      await atRest(journal, { settleAbandoned: !stopped, ...(stopped ? { stopped: true } : {}) })

      const record = journal.item(turnKey(STOPPED_TURN))?.body
      expect(record).toMatchObject({
        state: 'interrupted',
        ...(stopped ? { outcome: 'cancellation' } : {}),
        ...(ended ? { completedAt: Date.parse('2026-10-31T02:54:41.000Z') } : {})
      })
      const opener = record?.kind === 'turn' ? journal.item(record.userItemId ?? '') : null
      expect(opener?.body).toMatchObject({ kind: 'message', role: 'user' })
      // The stopped turn's own prompt, as the import saved it (no second opener id).
      expect(record?.kind === 'turn' && record.userItemId).toBe(
        imported.findLast(({ body }) => body.kind === 'message' && body.role === 'user')?.itemId
      )
      // Nothing it already saved is imported again.
      expect(journal.snapshot().items.filter(({ body }) => body.kind !== 'turn')).toEqual(imported)
      expect(turns(journal)).toHaveLength(1)
    }
  )
})

// Every agent's own lifecycle source decides: a killed turn settles as interrupted, a finished one
// keeps its end, and missing or ambiguous evidence gets no guessed label.
const claudeRecording = await readFile(
  join(import.meta.dirname, '__fixtures__', 'claude-cli-switch-2.1.302.jsonl'),
  'utf8'
)
const claudeRecordingId: string = JSON.parse(claudeRecording.split('\n')[0]!).sessionId
describe.each([
  ['claude', claudeRecordingId],
  ['pi', '01a1841b-2daa-7238-ade8-4b2474dcac14'],
  ['grok', '01a105db-937d-7ec0-b1d1-5396ae618abf'],
  ['opencode', 'ses_e7afa14d9ffernpe5xoa3e21SL'],
  ['opencode2', 'ses_e7bc5544cffeP7rTuOdvcklM2n']
] as const)('a %s turn with nothing left writing it', (agent, recordedId) => {
  const fixtures = join(import.meta.dirname, '__fixtures__', 'recorded-native-switch', agent)
  const sqlite = agent === 'opencode' || agent === 'opencode2'
  async function install(completed: boolean) {
    const target = join(root, sqlite ? 'native.db' : 'native.jsonl')
    if (agent === 'claude') {
      const rows = claudeRecording.trimEnd().split('\n')
      await writeFile(target, completed ? claudeRecording : `${rows.slice(0, 2).join('\n')}\n`)
    } else if (agent === 'grok') {
      const directory = join(fixtures, completed ? 'completed' : 'interrupted-prefix')
      await writeFile(target, await readFile(join(directory, 'chat_history.jsonl')))
      await writeFile(join(root, 'events.jsonl'), await readFile(join(directory, 'events.jsonl')))
    } else if (agent === 'pi') {
      const rows = (await readFile(join(fixtures, 'completed.jsonl'), 'utf8')).trimEnd().split('\n')
      await writeFile(target, `${(completed ? rows : rows.slice(0, 6)).join('\n')}\n`)
    } else {
      const name = `${completed ? 'completed' : 'recorded-prefix'}.db`
      await writeFile(target, await readFile(join(fixtures, name)))
    }
    return { agent, sessionId: agent === 'pi' ? target : recordedId, filePath: target }
  }
  async function settledTurns(completed: boolean) {
    const source = await install(completed)
    const journal = await journals.open({
      stateDirectory: root,
      identity: {
        sessionId: `${agent}-${String(completed)}`,
        workspaceId: 'folder',
        hostId: 'local',
        agent,
        providerHandle: agent === 'claude' ? claudeProviderHandle(recordedId, null) : null
      }
    })
    await importLegacyTranscriptIntoJournal({
      journal,
      agent,
      sessionId: source.sessionId,
      fence: 1,
      options: { filePath: source.filePath }
    })
    await catchUpSwitchedCliTranscript({
      journal,
      source,
      fence: 1,
      deadline,
      settleAbandoned: true
    })
    return turns(journal)
  }

  it('settles a killed turn as interrupted, with no Stop of its own', async () => {
    const [turn, ...rest] = await settledTurns(false)
    expect(rest).toEqual([])
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(turn).not.toHaveProperty('completedAt')
  })

  it('keeps a finished turn’s own end', async () => {
    const [turn, ...rest] = await settledTurns(true)
    expect(rest).toEqual([])
    expect(turn?.state).toBe('completed')
  })
})

it('gives a Claude reply only a legacy format calls finished no Interrupted label', async () => {
  const [first] = claudeRecording.trimEnd().split('\n')
  const sessionId: string = JSON.parse(first!).sessionId
  const target = join(root, 'legacy.jsonl')
  const user = JSON.parse(first!)
  await writeFile(
    target,
    `${first}\n${JSON.stringify({
      type: 'assistant',
      uuid: 'legacy-reply',
      sessionId,
      timestamp: new Date(Date.parse(user.timestamp) + 1).toISOString(),
      message: {
        role: 'assistant',
        id: 'legacy-reply-message',
        stop_reason: null,
        content: [{ type: 'text', text: 'All done.' }]
      }
    })}\n`
  )
  const source = { agent: 'claude' as const, sessionId, filePath: target }
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'legacy-claude',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(sessionId, null)
    }
  })
  await importLegacyTranscriptIntoJournal({
    journal,
    agent: 'claude',
    sessionId,
    fence: 1,
    options: { filePath: target }
  })
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, settleAbandoned: true })
  expect(turns(journal)).toEqual([])
})
