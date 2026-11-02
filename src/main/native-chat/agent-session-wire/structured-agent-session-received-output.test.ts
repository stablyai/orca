import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from '../../claude/structured/journal/claude-structured-journal-translation'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'

it('saves every tool result past 1,024 in one received Claude message, through reopen', async () => {
  const count = 1025
  const root = await mkdtemp(join(tmpdir(), 'sta-10949-'))
  const identity = {
    sessionId: 'orca-session',
    workspaceId: 'workspace',
    hostId: 'host',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('claude-session', null)
  }
  let journal = await openAgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(root)
  })
  const onFailed = vi.fn()
  const readingControl = { pauseReading: vi.fn(), resumeReading: vi.fn() }
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    onFailed,
    readingControl
  })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink })
  try {
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message: {
        type: 'user',
        uuid: 'tool-results',
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: Array.from({ length: count }, (_, index) => ({
            type: 'tool_result',
            tool_use_id: `tool-${index}`,
            content: `saved-result-${index}`
          }))
        }
      }
    })
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(onFailed).not.toHaveBeenCalled()
    expect(readingControl.pauseReading).toHaveBeenCalledOnce()
    expect(readingControl.resumeReading).toHaveBeenCalledOnce()
    await journal.close()
    await closeTestJournalHostDatabase(root)
    journal = await openAgentSessionJournal({
      identity,
      database: openTestJournalHostDatabase(root)
    })
    const tools = journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
    expect(tools).toHaveLength(count)
    expect(new Set(tools.map((item) => item.itemId)).size).toBe(count)
    tools.forEach((item, index) =>
      expect(JSON.stringify(item.body)).toContain(`saved-result-${index}`)
    )
  } finally {
    translator.dispose()
    deferred.close()
    await journal.close()
    await closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})
