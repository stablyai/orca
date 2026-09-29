import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { MAX_PROVIDER_DIAGNOSTIC_CHARS } from '../../shared/agent-session-failure'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'provider-1', leafUuid: 'leaf-1' }
}

/** A frame as Claude Code sends it while it retries a refused request. */
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
  await rm(root, { recursive: true, force: true })
})

async function statusRowsFor(frames: Record<string, unknown>[]) {
  const journal = await openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: () => 1_700_000_000_000,
    mintEpoch: () => 'epoch-1'
  })
  const deferred = createDeferredStructuredAgentSessionEventSink()
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
      text: 'Claude is rate-limited and retrying.',
      tone: 'warning',
      failure: {
        kind: 'providerRetrying',
        retry: { error: 'rate_limit', status: 429 },
        detail: { audience: 'log' }
      }
    })
    expect(row).not.toHaveProperty('providerFrame')
    // The latest attempt's frame, as the log detail.
    expect(row.failure?.detail?.text).toContain('"attempt":3')
  })

  it('starts a new row when a later run starts over', async () => {
    const rows = await statusRowsFor([apiRetry(1), apiRetry(2), apiRetry(1)])
    expect(rows.map((row) => row.text)).toEqual([
      'Claude is rate-limited and retrying.',
      'Claude is rate-limited and retrying.'
    ])
  })

  it('does not call a retry a rate limit unless the frame says so', async () => {
    const rows = await statusRowsFor([
      apiRetry(1, { error: 'overloaded', error_status: 529 }),
      apiRetry(1, { error: 'server_error', error_status: 500 }),
      apiRetry(1, { error: undefined, error_status: undefined }),
      apiRetry(1, { error: 'something_new', error_status: 429 })
    ])
    expect(rows.map((row) => row.text)).toEqual([
      'Claude hit a temporary problem and is retrying.',
      'Claude hit a temporary problem and is retrying.',
      'Claude hit a temporary problem and is retrying.',
      'Claude is rate-limited and retrying.'
    ])
    expect(rows[0]?.failure).toMatchObject({ retry: { error: 'overloaded', status: 529 } })
  })

  it('caps the frame it keeps as the detail', async () => {
    const [row] = await statusRowsFor([apiRetry(1, { padding: 'x'.repeat(5_000) })])
    expect(row?.failure?.detail?.text.length).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS)
  })

  it('leaves a frame kind no one catalogued to the provider fallback, as before', async () => {
    const unknown = {
      type: 'system',
      subtype: 'future_notice',
      error: 'rate_limit',
      session_id: 'provider-1',
      uuid: 'future-1'
    }
    const rows = await statusRowsFor([unknown])
    expect(rows).toEqual([
      unhandledProviderFrameJournalItem('claude', 'message:system:future_notice', unknown)?.body
    ])
    expect(rows[0]).toMatchObject({ text: 'rate_limit', tone: 'error' })
  })
})
