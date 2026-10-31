import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../../shared/agent-session-goal-control-copy'
import { refuse } from '../../../shared/agent-session-wire'
import { nativeChatTurnMembership } from '../../../shared/native-chat-turn-membership'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript,
  commitSwitchStoppedCliTurn,
  withSwitchStoppedTurn,
  type SwitchStoppedCliTurn,
  type SwitchTranscriptSource
} from './structured-agent-session-switch-import'
import {
  settleSwitchProvenChatStop,
  structuredAgentSessionChildStopFeedbackId
} from './structured-agent-session-switch-proven-chat-stop'

// A user's Stop reads "Interrupted" however the chat later reads the turn: from the agent's own stop
// record, or from a switch's proven stop recorded before anything later could fail.

const fixtures = join(import.meta.dirname, '__fixtures__')
const journals = createTrackedJournalOpener()
let root: string
let filePath: string
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-label-'))
  filePath = join(root, 'transcript.jsonl')
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function open(name: string, agent: AgentType, providerId: string) {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId: name,
      workspaceId: 'folder',
      hostId: 'local',
      agent,
      providerHandle:
        agent === 'codex'
          ? codexProviderHandle(providerId)
          : agent === 'claude'
            ? claudeProviderHandle(providerId, null)
            : null
    }
  })
}

/** The production refresh (Codex's resting import, or the shared one), with nothing left writing. */
async function refresh(
  journal: AgentSessionJournal,
  source: SwitchTranscriptSource,
  stopped?: SwitchStoppedCliTurn
) {
  await (source.agent === 'codex'
    ? catchUpStructuredSessionAtRest({
        journal,
        threadId: source.sessionId,
        filePath: source.filePath,
        fence: 1,
        deadline,
        stoppedTurnId: stopped?.turnId,
        stoppedUserItemKey: stopped?.userItemKey,
        settleAbandoned: true
      })
    : catchUpSwitchedCliTranscript({
        journal,
        source,
        fence: 1,
        deadline,
        stopped,
        settleAbandoned: true
      }))
}

/** The prompts in saved order, and each row's turn as the chat groups it. */
function shownTurns(journal: AgentSessionJournal) {
  const { items } = journal.snapshot()
  const messages = items
    .map(projectStructuredItemToNativeChat)
    .filter((message): message is NativeChatMessage => message !== null)
  const { turnKeys } = nativeChatTurnMembership(messages, {
    items,
    submissions: journal.submissions()
  })
  const prompts = messages.filter((message) => message.role === 'user')
  return {
    prompts: prompts.map((message) => message.id),
    turnOf: (id: string) => turnKeys[messages.findIndex((message) => message.id === id)],
    rowsAfter: (id: string) => messages.slice(messages.findIndex((message) => message.id === id))
  }
}

const turns = (journal: AgentSessionJournal) =>
  journal.snapshot().items.flatMap(({ body }) => (body.kind === 'turn' ? [body] : []))

function expectInterrupted(journal: AgentSessionJournal, turnId: string) {
  const turn = turns(journal).find((body) => body.turnId === turnId)
  const verdict = agentTurnVerdict({ state: turn?.state ?? null, outcome: turn?.outcome ?? null })
  expect(verdict).toBe('cancellation')
  expect(
    agentVerdictDisplayMark({ state: 'done', mainAgent: { state: 'done', outcome: verdict! } })
  ).toBe('interrupted')
  const { items } = journal.snapshot()
  expect(withNativeChatCutTurnNotices(items)).toBe(items)
}

const lines = (text: string) => text.trimEnd().split('\n')
const json = (line: string): Record<string, unknown> => JSON.parse(line)
/** A rollout row's payload field. */
const payload = (line: string, key: string) => {
  const value = json(line).payload
  return typeof value === 'object' && value !== null
    ? String(Object.entries(value).find(([name]) => name === key)?.[1])
    : ''
}
const at = (row: string, year: number, ms: number) =>
  JSON.stringify({ ...json(row), timestamp: new Date(Date.UTC(year, 0, 1) + ms).toISOString() })
const later = (row: string, ms: number) =>
  JSON.stringify({
    ...json(row),
    timestamp: new Date(Date.parse(String(json(row).timestamp)) + ms)
  })

describe('the Codex switches QA saw fail after the stop (the marker, no abort event)', () => {
  it.each(['codex-qa-3734-stop-marker-only-1.jsonl', 'codex-qa-3734-stop-marker-only-2.jsonl'])(
    '%s reads Interrupted after a failure, a retry from Session History and a restart',
    async (name) => {
      const recording = await readFile(join(fixtures, name), 'utf8')
      const rows = lines(recording)
      const thread = payload(rows[0]!, 'id')
      const stoppedTurn = payload(rows.at(-3)!, 'turn_id')
      const source = { agent: 'codex' as const, sessionId: thread, filePath }

      for (const retained of [false, true]) {
        const journal = await open(`${name}-${String(retained)}`, 'codex', thread)
        if (retained) {
          // A chat that already holds the first two turns; the CLI ran the third.
          await writeFile(filePath, `${rows.slice(0, 9).join('\n')}\n`)
          await importLegacyTranscriptIntoJournal({
            journal,
            agent: 'codex',
            sessionId: thread,
            fence: 1,
            options: { filePath }
          })
          await refresh(journal, source)
        }
        // The CLI's turn came after the chat's import (any later time will do).
        const cli = retained
          ? [...rows.slice(0, 9), ...rows.slice(9).map((row, index) => at(row, 2999, index))]
          : rows
        await writeFile(filePath, `${cli.join('\n')}\n`)
        const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
        expect(stopped?.turnId).toBe(stoppedTurn)
        // The stop is proven, then the history can't be read (QA hid the file 36 ms in).
        await rename(filePath, `${filePath}.hidden`)
        if (retained) {
          await commitSwitchStoppedCliTurn({ journal, stopped: stopped!, fence: 1 })
        } else {
          const read = withSwitchStoppedTurn(
            {
              ok: false,
              refusal: refuse(
                'agent_session_identity_required',
                { reason: 'transcriptUnreadable' },
                'hidden'
              )
            },
            stopped!
          )
          expect(read.ok).toBe(true)
          await journal.replaceEpochItems('legacy_import', 1, read.ok ? (read.items ?? []) : [])
        }
        expectInterrupted(journal, stoppedTurn)

        // Session History's retry, with no stop of its own, then a restart.
        await rename(`${filePath}.hidden`, filePath)
        await refresh(journal, source)
        expectInterrupted(journal, stoppedTurn)
        // The stopped turn's prompt comes last and its rows join its own turn, not the one before.
        const shown = shownTurns(journal)
        expect(shown.prompts).toHaveLength(3)
        const last = shown.prompts[2]!
        // Either import's name for the stopped prompt: the bare provider id is the shared part.
        const bare = (key: string) => decodeURIComponent(key).split(':').at(-1)
        expect(bare(last)).toBe(bare(stopped!.userItemKey))
        for (const row of shown.rowsAfter(last)) {
          expect(shown.turnOf(row.id)).toBe(last)
        }
        const settled = journal.snapshot()
        await journal.close()
        const reopened = await open(`${name}-${String(retained)}`, 'codex', thread)
        await refresh(reopened, source)
        expect(reopened.snapshot()).toEqual(settled)
      }
    }
  )

  it('keeps the ruled interruption with no proven stop and no abort record', async () => {
    const recording = await readFile(join(fixtures, 'codex-qa-3734-stop-marker-only-1.jsonl'))
    await writeFile(filePath, recording)
    const thread = payload(lines(String(recording))[0]!, 'id')
    const journal = await open('no-proof', 'codex', thread)
    await importLegacyTranscriptIntoJournal({
      journal,
      agent: 'codex',
      sessionId: thread,
      fence: 1,
      options: { filePath }
    })
    await refresh(journal, { agent: 'codex', sessionId: thread, filePath })
    const [turn] = turns(journal)
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(agentTurnVerdict({ state: turn!.state, outcome: null })).toBe('interruption')
  })
})

describe('a Stop and switch into the chat that already holds the conversation', () => {
  // Recorded on the QA Mac: the chat ran W2a; the CLI ran W2b to the end, then W2c until Stop.
  // Rows 0-1 are W2a, 2-3 W2b, 4-6 W2c up to the stop, 7 the notice Claude writes as it stops.
  it.each([false, true])(
    'Claude keeps W2a, W2b, W2c in order with W2c its own turn (file hidden after the stop: %s)',
    async (hidden) => {
      const rows = lines(
        await readFile(join(fixtures, 'claude-qa-final-stop-third-turn.jsonl'), 'utf8')
      )
      const providerId = String(json(rows[0]!).sessionId)
      const source = { agent: 'claude' as const, sessionId: providerId, filePath }
      const journal = await open(`claude-retained-${String(hidden)}`, 'claude', providerId)
      await writeFile(filePath, `${rows.slice(0, 2).join('\n')}\n`)
      await importLegacyTranscriptIntoJournal({
        journal,
        agent: 'claude',
        sessionId: providerId,
        fence: 1,
        options: { filePath }
      })
      await writeFile(filePath, `${rows.slice(0, 7).join('\n')}\n`)
      const stopped = await captureSwitchStoppedCliTurn(source, true, deadline, { journal })
      const [w2a, w2aReply, w2b, w2bReply, w2c, , w2cReply] = rows.map(
        (row) => `claude:${providerId}:${String(json(row).uuid)}`
      )
      expect(stopped?.userItemKey).toBe(w2c)
      await writeFile(filePath, `${rows.join('\n')}\n`)
      if (hidden) {
        await rename(filePath, `${filePath}.hidden`)
      }
      await commitSwitchStoppedCliTurn({ journal, stopped: stopped!, fence: 1 })
      const expectInOrder = () => {
        expectInterrupted(journal, stopped!.turnId)
        const shown = shownTurns(journal)
        expect(shown.prompts.slice(0, 3)).toEqual([w2a, w2b, w2c])
        // Saved in transcript order: W2c's partial reply follows its prompt, after all of W2b.
        const order = journal.snapshot().items.map(({ itemId }) => itemId)
        expect(
          [w2a, w2aReply, w2b, w2bReply, w2c, w2cReply].map((id) => order.indexOf(id))
        ).toEqual([0, 1, 2, 3, 4, 5])
        expect(shown.turnOf(w2c)).toBe(w2c)
        for (const reply of [w2bReply, w2cReply]) {
          expect([undefined, w2c]).toContain(shown.turnOf(reply))
        }
      }
      if (hidden) {
        await expect(refresh(journal, source, stopped)).rejects.toThrow()
        expectInOrder()
        // Session History's retry once the file is back.
        await rename(`${filePath}.hidden`, filePath)
        await refresh(journal, source)
      } else {
        await refresh(journal, source, stopped)
      }
      expectInOrder()
    }
  )
})

describe('Codex: a Stop and switch into the chat after Codex wrote its own abort (Windows QA 3807)', () => {
  // Ids from the run's journal and rollout; text is the prompt's label, and A's and D's item ids
  // weren't captured. The chat sent A (and D after the restart); the CLI ran B to the end, then C
  // until Stop. Rows 1-6 are A, 7-11 B, 12-14 C up to the stop, 15-16 the abort Codex writes as it
  // stops, 17-21 D. User lines carry msg_ ids and no turn id; the import reads the UserMessage items.
  const recording = async () =>
    lines(await readFile(join(fixtures, 'codex-qa-3807-retained-stop-third-turn.jsonl'), 'utf8'))
  /** A nested rollout field, read without casts. */
  const dig = (value: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>(
      (current, key) =>
        typeof current === 'object' && current !== null
          ? Object.entries(current).find(([name]) => name === key)?.[1]
          : undefined,
      value
    )
  const time = (row: string) => Date.parse(String(json(row).timestamp))

  /** A turn the chat sent and Codex answered, saved as the chat saves it. */
  async function chatSentTurn(journal: AgentSessionJournal, thread: string, rows: string[]) {
    const turnId = payload(rows[0]!, 'turn_id')
    const items = rows.map((row) => dig(json(row), 'payload', 'item'))
    const prompt = items.find((item) => dig(item, 'type') === 'UserMessage')
    const reply = items.find((item) => dig(item, 'type') === 'AgentMessage')
    const text = (item: unknown) => [
      { type: 'text' as const, text: String(dig(item, 'content', '0', 'text')) }
    ]
    const clientMessageId = String(dig(prompt, 'client_id'))
    const record = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'chat',
      recordId: `turn-lifecycle:${turnId}`
    }
    await journal.appendPlannedLifecycleBatch({
      settlementId: `chat:${turnId}`,
      fence: 1,
      plan: () => ({
        dispatches: [],
        mutations: [
          {
            kind: 'item',
            identity: { provider: 'orca', clientMessageId },
            body: { kind: 'message', role: 'user', blocks: text(prompt) },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          {
            kind: 'item',
            identity: record,
            body: {
              kind: 'turn',
              turnId,
              state: 'completed',
              outcome: 'success',
              userItemId: agentJournalSubmissionKey(clientMessageId),
              startedAt: time(rows[0]!),
              completedAt: time(rows.at(-1)!)
            },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          },
          {
            kind: 'item',
            identity: { provider: 'codex', threadId: thread, turnId, ordinal: 1 },
            body: { kind: 'message', role: 'assistant', blocks: text(reply) },
            turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(record) }
          }
        ]
      })
    })
  }

  /** The chat's A, the CLI's B, then Stop and switch during C, through the production commit and refresh. */
  async function stopAndSwitchDuringC(name: string) {
    const rows = await recording()
    const thread = payload(rows[0]!, 'id')
    const source = { agent: 'codex' as const, sessionId: thread, filePath }
    const journal = await open(name, 'codex', thread)
    await chatSentTurn(journal, thread, rows.slice(1, 7))
    await writeFile(filePath, `${rows.slice(0, 15).join('\n')}\n`)
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline, { journal })
    expect(stopped?.turnId).toBe(payload(rows[12]!, 'turn_id'))
    await writeFile(filePath, `${rows.slice(0, 17).join('\n')}\n`)
    await commitSwitchStoppedCliTurn({ journal, stopped: stopped!, fence: 1 })
    await refresh(journal, source, stopped)
    const imported = (row: string) =>
      agentJournalItemKey({
        provider: 'legacy',
        agent: 'codex',
        sessionId: thread,
        recordId: String(dig(json(row), 'payload', 'item', 'id'))
      })
    const prompts = {
      a: agentJournalSubmissionKey(String(dig(json(rows[4]!), 'payload', 'item', 'client_id'))),
      b: imported(rows[9]!),
      bReply: imported(rows[10]!),
      c: imported(rows[14]!)
    }
    return { rows, thread, source, journal, stopped: stopped!, prompts }
  }

  function expectInterruptedOnCOnly(
    journal: AgentSessionJournal,
    stoppedTurn: string,
    prompts: { a: string; b: string; bReply: string; c: string }
  ) {
    expectInterrupted(journal, stoppedTurn)
    const shown = shownTurns(journal)
    expect(shown.prompts.slice(0, 3)).toEqual([prompts.a, prompts.b, prompts.c])
    expect(shown.turnOf(prompts.b)).toBe(prompts.b)
    expect(shown.turnOf(prompts.bReply)).toBe(prompts.b)
    // C's only row is its prompt (Codex was stopped before any reply): it opens its own turn.
    expect(shown.turnOf(prompts.c)).toBe(prompts.c)
    // The chat marks a turn by its prompt: only C reads Interrupted.
    const { items } = journal.snapshot()
    const marked = [...selectStructuredAgentSettledTurns(items, journal.submissions())].flatMap(
      ([prompt, settled]) => (settled?.verdict === 'cancellation' ? [prompt] : [])
    )
    expect(marked).toEqual([prompts.c])
  }

  it('keys C to its own prompt and marks only C, before and after the restart and a later turn', async () => {
    const { rows, thread, source, journal, stopped, prompts } =
      await stopAndSwitchDuringC('codex-3807')
    // The stopped turn's record names C's prompt, as do B's.
    const records = turns(journal)
    expect(records.find((body) => body.turnId === stopped.turnId)?.userItemId).toBe(prompts.c)
    expect(records.find((body) => body.turnId === payload(rows[7]!, 'turn_id'))?.userItemId).toBe(
      prompts.b
    )
    expectInterruptedOnCOnly(journal, stopped.turnId, prompts)

    // After the restart the chat sends D; a later import and a reopen keep C where it is.
    await chatSentTurn(journal, thread, rows.slice(17))
    await writeFile(filePath, `${rows.join('\n')}\n`)
    await refresh(journal, source)
    expectInterruptedOnCOnly(journal, stopped.turnId, prompts)
    const settled = journal.snapshot()
    await journal.close()
    const reopened = await open('codex-3807', 'codex', thread)
    await refresh(reopened, source)
    expect(reopened.snapshot()).toEqual(settled)
    expectInterruptedOnCOnly(reopened, stopped.turnId, prompts)
  })

  it('heals a journal saved without the prompts: the next import names them', async () => {
    const { source, journal, stopped, prompts } = await stopAndSwitchDuringC('codex-3807-saved')
    // What the earlier build saved: B's and C's records with no prompt, C's ahead of B's rows.
    const unanchored = journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'turn' && item.body.userItemId !== prompts.a
          ? [{ itemId: item.itemId, body: { ...item.body, userItemId: undefined } }]
          : []
      )
    expect(unanchored).toHaveLength(2)
    await journal.appendPlannedLifecycleBatch({
      settlementId: 'earlier-build',
      fence: 1,
      plan: () => ({
        dispatches: [],
        mutations: unanchored.map(({ itemId, body }) => ({
          kind: 'item' as const,
          itemId,
          body,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }))
      })
    })
    expect(turns(journal).filter((body) => body.userItemId === undefined)).toHaveLength(2)
    expect(shownTurns(journal).turnOf(prompts.c)).not.toBe(prompts.c)

    await refresh(journal, source)
    expectInterruptedOnCOnly(journal, stopped.turnId, prompts)
  })
})

describe("each agent's own stop record, then an idle switch", () => {
  const claudeRows = async () =>
    lines(await readFile(join(fixtures, 'claude-cli-switch-2.1.302.jsonl'), 'utf8'))
  const piRows = async () =>
    lines(await readFile(join(fixtures, 'recorded-native-switch', 'pi', 'completed.jsonl'), 'utf8'))
  const codexRows = async () =>
    lines(await readFile(join(fixtures, 'codex-qa-3734-stop-marker-only-1.jsonl'), 'utf8'))

  /** The agent's transcript up to a turn the user stopped in the CLI, and that turn's id. */
  async function stoppedInCli(agent: 'claude' | 'codex' | 'pi') {
    if (agent === 'codex') {
      const rows = await codexRows()
      const turnId = payload(rows.at(-3)!, 'turn_id')
      const abort = later(rows.at(-1)!, 30)
      const aborted = { ...json(abort), type: 'event_msg' }
      return {
        rows: [
          ...rows,
          JSON.stringify({
            ...aborted,
            payload: { type: 'turn_aborted', reason: 'interrupted', turn_id: turnId }
          })
        ],
        providerId: payload(rows[0]!, 'id'),
        turnId
      }
    }
    if (agent === 'claude') {
      const rows = (await claudeRows()).slice(0, 2)
      const prompt = json(rows[0]!)
      // Esc before Claude replied: the notice names no interrupted message.
      const notice = JSON.stringify({
        type: 'user',
        uuid: 'esc-notice',
        sessionId: prompt.sessionId,
        timestamp: new Date(Date.parse(String(json(rows[1]!).timestamp)) + 1).toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }]
        }
      })
      return { rows: [...rows, notice], providerId: String(prompt.sessionId), turnId: null }
    }
    const rows = (await piRows()).slice(0, 6)
    const aborted = JSON.stringify({
      type: 'message',
      id: 'pi-aborted',
      parentId: json(rows[5]!).id,
      timestamp: json(rows[5]!).timestamp,
      message: { role: 'assistant', content: [], stopReason: 'aborted' }
    })
    return { rows: [...rows, aborted], providerId: filePath, turnId: null }
  }

  it.each(['claude', 'codex', 'pi'] as const)(
    '%s: Interrupted, and an earlier import that saved it without a verdict is repaired',
    async (agent) => {
      const recorded = await stoppedInCli(agent)
      await writeFile(filePath, `${recorded.rows.join('\n')}\n`)
      const source = { agent, sessionId: recorded.providerId, filePath }
      const journal = await open(`${agent}-esc`, agent, recorded.providerId)
      await importLegacyTranscriptIntoJournal({
        journal,
        agent,
        sessionId: source.sessionId,
        fence: 1,
        options: { filePath }
      })
      await refresh(journal, source)
      const [turn, ...rest] = turns(journal)
      expect(rest).toEqual([])
      expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
      if (recorded.turnId) {
        expect(turn?.turnId).toBe(recorded.turnId)
      }
      expectInterrupted(journal, turn!.turnId)

      // What an earlier import saved for it, before the decoders kept the user's Stop.
      const item = journal.snapshot().items.find(({ body }) => body.kind === 'turn')!
      const { outcome: _outcome, ...wrong } = turn!
      const wrongJournal = await open(`${agent}-wrong`, agent, recorded.providerId)
      await importLegacyTranscriptIntoJournal({
        journal: wrongJournal,
        agent,
        sessionId: source.sessionId,
        fence: 1,
        options: { filePath }
      })
      const identity = {
        provider: 'legacy' as const,
        agent,
        sessionId: source.sessionId,
        recordId: `turn-lifecycle:${turn!.turnId}`
      }
      expect(agentJournalItemKey(identity)).toBe(item.itemId)
      await wrongJournal.appendItem(identity, wrong, {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const before = wrongJournal.snapshot().items
      await refresh(wrongJournal, source)
      expect(wrongJournal.item(item.itemId)?.body).toEqual({ ...wrong, outcome: 'cancellation' })
      expect(wrongJournal.snapshot().items.map(({ itemId }) => itemId)).toEqual(
        before.map(({ itemId }) => itemId)
      )
      const repaired = wrongJournal.snapshot()
      await refresh(wrongJournal, source)
      expect(wrongJournal.snapshot()).toEqual(repaired)
    }
  )
})

describe('a chat a switch stopped and proved exited', () => {
  const child = { fence: 3, generation: 'generation-1' }
  const identity = structuredAgentSessionStopNoteIdentity(
    structuredAgentSessionChildStopFeedbackId(child)
  )
  async function withUnconfirmedNote(name: string) {
    const journal = await open(name, 'codex', '01a190ce-384d-7be3-b9b1-92f7069b4966')
    await journal.appendItem(
      identity,
      {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), {
          surface: 'row',
          stopNotice: 'stopUnconfirmed'
        })
      },
      { fence: 3, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return journal
  }
  const shown = (journal: AgentSessionJournal) => JSON.stringify(journal.snapshot().items)

  it('drops the Stop note that could not confirm the exit', async () => {
    const journal = await withUnconfirmedNote('proven')
    expect(shown(journal)).toContain(AGENT_SESSION_GOAL_CONTROL_COPY.stopUnconfirmed)
    await settleSwitchProvenChatStop({ journal, fence: 3, child, pause: 'acknowledged' })
    expect(shown(journal)).not.toContain(AGENT_SESSION_GOAL_CONTROL_COPY.stopUnconfirmed)
    await journal.close()
    const reopened = await open('proven', 'codex', '01a190ce-384d-7be3-b9b1-92f7069b4966')
    expect(shown(reopened)).not.toContain(AGENT_SESSION_GOAL_CONTROL_COPY.stopUnconfirmed)
  })

  it('keeps only what is still unknown: a goal pause Codex never acknowledged', async () => {
    const journal = await withUnconfirmedNote('pause')
    await settleSwitchProvenChatStop({ journal, fence: 3, child, pause: 'unconfirmed' })
    expect(shown(journal)).not.toContain(AGENT_SESSION_GOAL_CONTROL_COPY.stopUnconfirmed)
    expect(shown(journal)).toContain(AGENT_SESSION_GOAL_CONTROL_COPY.pauseUnconfirmed)
  })
})
