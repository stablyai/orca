import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import {
  fakeClaude,
  adapterFor,
  identityFor,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import { fakeCodexAppServer } from '../../codex/codex-structured-dispatch-test-support'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  codexProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'

it.each([1024, 1025])('saves all %i tool results in one received Claude message', async (count) => {
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
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(),
    onFailed
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
    await journal.close()
    closeTestJournalHostDatabase(root)
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
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

afterEach(closeProviderTimelineRigs)

it.each(['publish', 'cancel', 'exit'] as const)(
  'transfers Claude startup output on %s',
  async (outcome) => {
    const rig = await openProviderTimelineRig(
      {},
      { agent: 'claude', providerHandle: claudeProviderHandle(PROVIDER_SESSION_ID, null) }
    )
    const source = fakeClaude()
    const entered = Promise.withResolvers<void>()
    const initialization = Promise.withResolvers<void>()
    const open = source.openConnection
    source.openConnection = async (launch, handlers = {}) => {
      const connection = await open(launch, handlers)
      for (let index = 0; index < 1025; index++) {
        handlers.onMessage?.({
          type: 'user',
          session_id: PROVIDER_SESSION_ID,
          uuid: `early-${index}`,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: `early-${index}`, content: `startup-${index}` }
            ]
          }
        })
      }
      const pause = (connection.pauseReading = vi.fn())
      const initialize = connection.initializationResult
      connection.initializationResult = (...args) => {
        expect(pause).not.toHaveBeenCalled()
        return initialize(...args)
      }
      entered.resolve()
      await initialization.promise
      return connection
    }
    const adapter = adapterFor(source)
    const starting = adapter.acquire({
      identity: identityFor(),
      fence: 1,
      spawnToken: 'spawn',
      events: rig.eventSink
    })
    const failure = starting.catch((error: unknown) => error)
    await entered.promise
    let closing: Promise<boolean> | undefined
    if (outcome === 'cancel') {
      closing = adapter.closeSession('session-1')
    }
    if (outcome === 'exit') {
      source.connections[0].closed = true
      source.connections[0].handlers.onExit?.(new Error('provider exited before publication'))
    }
    initialization.resolve()
    try {
      if (outcome === 'publish') {
        await starting
      } else {
        expect(await failure).toBeInstanceOf(Error)
      }
      if (closing) {
        await closing
      }
      await adapter.closeAll()
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((item) => item.body.kind === 'tool-call')
      expect(tools).toHaveLength(1025)
      expect(JSON.stringify(tools.at(-1)?.body)).toContain('startup-1024')
      expect(new Set(tools.map((item) => item.itemId)).size).toBe(1025)
    } finally {
      await adapter.closeAll()
    }
  }
)

it.each(['publish', 'cancel', 'exit'] as const)(
  'transfers Codex startup output on %s without blocking initialization',
  async (outcome) => {
    const rig = await openProviderTimelineRig(
      {},
      { agent: 'codex', providerHandle: codexProviderHandle('thread-abc') }
    )
    const source = fakeCodexAppServer()
    const initialized = Promise.withResolvers<unknown>()
    const requested = Promise.withResolvers<void>()
    source.routes.initialize = () => {
      requested.resolve()
      return initialized.promise
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: null
      }),
      openConnection: source.openConnection,
      readProcessStartTime: async () => 1700000000000
    })
    const acquired = await adapter.acquire({
      identity: {
        ...identityFor(),
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-abc')
      },
      fence: 1,
      spawnToken: 'spawn',
      events: rig.eventSink
    })
    const opening = adapter.open({
      sessionId: 'session-1',
      fence: 1,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    const failure = opening.catch((error: unknown) => error)
    await requested.promise
    const connection = source.connections[0]
    const pause = (connection.pauseReading = vi.fn())
    for (let index = 0; index < 1025; index++) {
      connection.handlers.onNotification?.('item/completed', {
        threadId: 'thread-abc',
        turnId: 'early-turn',
        item: {
          id: `early-${index}`,
          type: 'commandExecution',
          command: 'echo output',
          status: 'completed',
          aggregatedOutput: `startup-${index}`,
          exitCode: 0
        }
      })
    }
    expect(pause).not.toHaveBeenCalled()
    let closing: Promise<boolean> | undefined
    if (outcome === 'cancel') {
      closing = adapter.closeSession('session-1')
    }
    if (outcome === 'exit') {
      connection.closed = true
      connection.handlers.onExit?.(new Error('provider exited before publication'))
    }
    initialized.resolve({})
    try {
      if (outcome === 'publish') {
        await opening
      } else {
        expect(await failure).toBeInstanceOf(Error)
      }
      if (closing) {
        await closing
      }
      await adapter.closeAll()
      const reopened = await rig.reopenJournal()
      const tools = reopened.snapshot().items.filter((item) => item.body.kind === 'tool-call')
      expect(tools).toHaveLength(1025)
      expect(JSON.stringify(tools.at(-1)?.body)).toContain('startup-1024')
      expect(new Set(tools.map((item) => item.itemId)).size).toBe(1025)
    } finally {
      await adapter.closeAll()
    }
  }
)
