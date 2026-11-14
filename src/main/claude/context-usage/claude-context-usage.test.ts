import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { selectStructuredAgentContextUsage } from '../../../shared/agent-session/structured-agent-session-context-usage'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'
import { bindClaudeContextUsageCapture } from './claude-context-usage'

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-context-usage-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function frame(message: Record<string, unknown>, observedAt: number, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    observedAt,
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', parent_tool_use_id: null, ...message }
  }
}

// Gateways that convert OpenAI streams send usage only in message_delta, so Claude's frames carry zeros.
const responseWithoutUsage = (uuid: string, at: number) =>
  frame(
    {
      type: 'assistant',
      uuid,
      message: {
        role: 'assistant',
        model: 'deepseek-v4.1-flash',
        content: [{ type: 'text', text: uuid }],
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    },
    at
  )

it('shows the report after a compaction when responses carry no usage', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: 'orca-session',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-session', null)
    },
    now: () => 9_000,
    stateDirectory: join(root, 'orca-session')
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, coalesceMs: 0 })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const answers: ((value: unknown) => void)[] = []
  const unbind = bindClaudeContextUsageCapture(
    { getContextUsage: () => new Promise((resolve) => answers.push(resolve)) },
    translator,
    { now: () => 20_000 }
  )
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 4; index += 1) {
      await Promise.resolve()
    }
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
  }
  const ring = () => selectStructuredAgentContextUsage(journal.snapshot().items)

  translator.handle(
    frame({ type: 'system', subtype: 'init', uuid: 'init', model: 'deepseek-v4.1-flash' }, 900)
  )
  translator.handle(
    frame(
      {
        type: 'user',
        uuid: 'turn-a',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
      },
      1_000,
      true
    )
  )
  translator.handle(responseWithoutUsage('reply-a', 2_000))
  translator.handle(
    frame(
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact',
        compact_metadata: { trigger: 'auto' }
      },
      3_000
    )
  )
  translator.handle(responseWithoutUsage('reply-a2', 4_000))
  await settle()
  expect(ring()).toBeNull()

  answers.at(-1)?.({
    model: 'deepseek-v4.1-flash',
    totalTokens: 40_000,
    rawMaxTokens: 200_000,
    categories: []
  })
  await settle()
  expect(ring()).toMatchObject({ usedTokens: 40_000, windowTokens: 200_000, estimated: false })
  unbind?.()
  translator.dispose()
  deferred.close()
})
