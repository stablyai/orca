import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabase,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { catchUpCodexThread } from './codex-structured-thread-catch-up'

export const SESSION = 'session-codex-catch-up'

export const THREAD = 'thread-abc'

export const STARTED_AT = 1_700_000_000

export function turn(index: number, view: 'full' | 'summary' = 'full'): Record<string, unknown> {
  return {
    id: `turn-${index}`,
    status: 'completed',
    itemsView: view,
    startedAt: STARTED_AT + index * 100,
    completedAt: STARTED_AT + index * 100 + 50,
    items: [
      { type: 'userMessage', id: `u-${index}`, content: [{ type: 'text', text: `ask ${index}` }] },
      { type: 'agentMessage', id: `a-${index}`, text: `answer ${index}` }
    ]
  }
}

export function codexWith(turns: Record<string, unknown>[]) {
  return {
    request: async (method: string, params?: Record<string, unknown>) => {
      expect(method).toBe('thread/turns/list')
      expect(params).toMatchObject({ sortDirection: 'desc', limit: 100 })
      const newestFirst = turns.toReversed()
      const start = typeof params?.cursor === 'string' ? Number(params.cursor) : 0
      const data = newestFirst.slice(start, start + 2)
      return {
        data,
        nextCursor: start + 2 < newestFirst.length ? String(start + 2) : null
      }
    }
  }
}

export const journals = createTrackedJournalOpener({ legacyInputs: true })

export const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

export async function chat(clock: { now: number }) {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-catch-up-'))
  const journalOptions = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    } satisfies AgentSessionJournalIdentity,
    stateDirectory: root,
    now: () => clock.now
  }
  let journal = await journals.open(journalOptions)
  let deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const publications: number[] = []
  const bind = () =>
    deferred.bind({
      journal,
      fence: 1,
      publish: () => {
        publications.push(journal.snapshot().items.length)
      }
    })
  bind()
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  return {
    get journal() {
      return journal
    },
    get deferred() {
      return deferred
    },
    root,
    get db() {
      return openTestJournalHostDatabase(root).db
    },
    publications,
    reopen: async () => {
      deferred.close()
      await journal.close()
      await closeTestJournalHostDatabase(root)
      journal = await journals.open(journalOptions)
      deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      bind()
    },
    open: async (
      turns: Record<string, unknown>[],
      options: Partial<Parameters<typeof catchUpCodexThread>[0]> = {}
    ) => {
      await catchUpCodexThread({
        connection: codexWith(turns),
        threadId: THREAD,
        sessionId: SESSION,
        sink: deferred.sink,
        ...options
      })
      return deferred.drained()
    },
    texts: () =>
      journal.snapshot().items.flatMap((item) => {
        if (item.body.kind === 'message') {
          const text = item.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
          return [`${item.body.role}:${text.join('')}`]
        }
        return item.body.kind === 'status' && item.body.presentation
          ? [`(${item.body.presentation})`]
          : []
      })
  }
}
