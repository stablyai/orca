import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('provider-1', 'leaf-1')
}

function apiRetry(attempt: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 10,
    retry_delay_ms: 622,
    error_status: 429,
    error: 'rate_limit',
    session_id: 'provider-1',
    uuid: `9b2f6a1e-0c4d-4e7a-8f3b-00000000000${attempt}`,
    ...fields
  }
}

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-api-retry-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function statusRowsFor(frames: Record<string, unknown>[]) {
  const journal = await openAgentSessionJournal({
    identity: IDENTITY,
    database: openTestJournalHostDatabase(root),
    now: () => 1_700_000_000_000,
    mintEpoch: () => 'epoch-1'
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: vi.fn() })
  const translator = createClaudeJournalTranslator({ sink: deferred.sink, fallbackIdPrefix: '1' })
  for (const frame of frames) {
    translator.handle({ type: 'message', sessionId: 'orca-session', message: frame })
    await deferred.drained()
  }
  return journal
    .snapshot()
    .items.flatMap((item): Extract<AgentJournalItemBody, { kind: 'status' }>[] =>
      item.body.kind === 'status' ? [item.body] : []
    )
}

describe('a Claude api_retry frame', () => {
  it('writes one sentence row per retry run, revised by each attempt, not the frame', async () => {
    const rows = await statusRowsFor([apiRetry(1), apiRetry(2), apiRetry(3)])

    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row).toMatchObject({
      text: 'Claude is rate-limited and retrying. Retry 3 of 10.\nLast error: HTTP 429 rate limit.',
      tone: 'warning',
      failure: {
        kind: 'providerRetrying',
        retry: { error: 'rate_limit', status: 429, attempt: 3, maxRetries: 10 },
        detail: { audience: 'log' }
      }
    })
    expect(row).not.toHaveProperty('providerFrame')
    expect(row.failure?.detail?.text).toContain('"attempt":3')
  })

  it('hides unmodeled system frames even when their payload names an error', async () => {
    const unknown = {
      type: 'system',
      subtype: 'future_notice',
      error: 'rate_limit',
      session_id: 'provider-1',
      uuid: 'future-1'
    }
    const rows = await statusRowsFor([unknown])
    expect(rows).toEqual([])
  })
})
