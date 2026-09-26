// A Codex subagent's rows, through the real path a parent's surfaces read them:
// translator → deferred sink → on-disk journal → snapshot → the shared readers.
// Every reader here answers for the SESSION'S OWN agent, so a child's row must
// never decide what it says; the transcript still renders every agent's rows.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { selectStructuredAgentTurnActivity } from '../../shared/native-chat-turn-activity'
import { latestStructuredAgentSessionAssistantMessage } from '../../shared/structured-agent-session-latest-request'
import {
  isStructuredAgentSessionThinking,
  statusStructuredAgentSessionToolCall
} from '../../shared/structured-agent-session-live-turn'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexThreadItem } from './codex-thread-item-identity'

const SESSION = 'session-codex-children'
const PARENT = 'thread-parent'
const CHILD = 'thread-child'
const PARENT_TURN = 'turn-parent'
const CHILD_TURN = 'turn-child'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function openJournal(root: string): Promise<AgentSessionJournal> {
  return openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: PARENT }
    },
    journalDir: root,
    now: () => 1_000
  })
}

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-children-'))
  let journal = await openJournal(root)
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => PARENT,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const on = (threadId: string, method: string, params: Record<string, unknown> = {}) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId,
      method,
      params: { threadId, ...params }
    })
  const item = (threadId: string, method: string, turnId: string, body: CodexThreadItem) =>
    on(threadId, method, { turnId, item: body })
  return {
    on,
    item,
    /** The parent's turn is open and has spawned a running child. */
    spawnChild: () => {
      on(PARENT, 'turn/started', { turn: { id: PARENT_TURN } })
      const spawn = {
        type: 'subAgentActivity',
        id: 'spawn-1',
        kind: 'started',
        agentThreadId: CHILD,
        agentPath: '/root/review'
      }
      item(PARENT, 'item/started', PARENT_TURN, spawn)
      item(PARENT, 'item/completed', PARENT_TURN, spawn)
      on(CHILD, 'turn/started', { turn: { id: CHILD_TURN } })
    },
    items: async (): Promise<readonly AgentJournalRenderItem[]> => {
      await deferred.drained()
      return journal.snapshot().items
    },
    /** Closes and reopens the journal file, so reads come from what was persisted. */
    reopen: async (): Promise<readonly AgentJournalRenderItem[]> => {
      await deferred.drained()
      deferred.unbind()
      await journal.close()
      journal = await openJournal(root)
      return journal.snapshot().items
    }
  }
}

describe("a Codex subagent's rows on the parent's surfaces", () => {
  it("names the parent's own tool, not the child's running command", async () => {
    const { spawnChild, item, items } = await session()
    spawnChild()
    item(PARENT, 'item/completed', PARENT_TURN, {
      type: 'commandExecution',
      id: 'own-cmd',
      command: 'git status',
      status: 'completed',
      exitCode: 0
    })
    item(CHILD, 'item/started', CHILD_TURN, {
      type: 'commandExecution',
      id: 'child-cmd',
      command: 'pnpm test',
      status: 'inProgress'
    })

    const rows = await items()
    const named = statusStructuredAgentSessionToolCall(rows)
    expect(JSON.stringify(named)).toContain('git status')
    expect(JSON.stringify(named)).not.toContain('pnpm test')
    // The transcript is unscoped: the child's command is still a row.
    expect(JSON.stringify(rows)).toContain('pnpm test')
  })

  it("does not read the child's reasoning as the parent thinking", async () => {
    const { spawnChild, item, items } = await session()
    spawnChild()
    item(PARENT, 'item/completed', PARENT_TURN, {
      type: 'agentMessage',
      id: 'own-msg',
      text: 'I asked a reviewer.'
    })
    item(CHILD, 'item/completed', CHILD_TURN, {
      type: 'reasoning',
      id: 'child-reasoning',
      summary: ['Reading the diff']
    })

    expect(isStructuredAgentSessionThinking(await items())).toBe(false)
  })

  it("does not show the child's compaction as the parent's activity line", async () => {
    const { spawnChild, item, items } = await session()
    spawnChild()
    item(CHILD, 'item/completed', CHILD_TURN, { type: 'contextCompaction', id: 'child-compact' })

    const rows = await items()
    expect(selectStructuredAgentTurnActivity(rows, PARENT_TURN)).toBeNull()
    expect(
      rows.some((row) => row.body.kind === 'status' && row.body.text === 'Context compacted')
    ).toBe(true)
  })

  it("quotes the parent's own latest line, and still does after a reopen", async () => {
    const { spawnChild, item, reopen } = await session()
    spawnChild()
    item(PARENT, 'item/completed', PARENT_TURN, {
      type: 'agentMessage',
      id: 'own-msg',
      text: 'I asked a reviewer.'
    })
    item(CHILD, 'item/completed', CHILD_TURN, {
      type: 'agentMessage',
      id: 'child-msg',
      text: 'Looks good to me.'
    })

    expect(latestStructuredAgentSessionAssistantMessage(await reopen())).toBe('I asked a reviewer.')
  })
})
