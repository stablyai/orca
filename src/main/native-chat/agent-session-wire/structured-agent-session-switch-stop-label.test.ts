import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat/transcript/native-chat-cut-turn-notice'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_SESSION_GOAL_CONTROL_COPY } from '../../../shared/agent-session-goal-control-copy'
import { refuse } from '../../../shared/agent-session-wire'
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

/** The production refresh: Codex's resting import, then the shared one; nothing left writing. */
async function refresh(journal: AgentSessionJournal, source: SwitchTranscriptSource) {
  if (source.agent === 'codex') {
    await catchUpStructuredSessionAtRest({
      journal,
      threadId: source.sessionId,
      filePath: source.filePath,
      fence: 1,
      deadline,
      settleAbandoned: true
    })
  }
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, settleAbandoned: true })
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
            { ok: false, refusal: refuse('agent_session_identity_required', {}, 'hidden') },
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
        const prompt = journal
          .snapshot()
          .items.filter(({ body }) => body.kind === 'message' && body.role === 'user')
        expect(prompt).toHaveLength(3)
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
