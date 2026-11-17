import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adapterAtPublishFor,
  fakeClaude,
  claudeFrame,
  identityFor,
  recordingJournalSink,
  PROVIDER_SESSION_ID
} from '../claude-structured-session-test-support'

import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import type { ClaudeStructuredLaunch } from '../launch/claude-structured-launch-resolution'

const owned: {
  claude: ReturnType<typeof fakeClaude>
  adapter: ReturnType<typeof adapterAtPublishFor>
  opens: Promise<unknown>[]
}[] = []

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

const fixture = (name: string): Record<string, unknown>[] =>
  readFileSync(new URL(`../../__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const MISSING = fixture('claude-missing-conversation')[0]!
const errorRows = (appendItem: ReturnType<typeof vi.fn>) =>
  appendItem.mock.calls.filter(([, body]) => body.kind === 'status' && body.tone === 'error')

function adapterFor(
  claude: ReturnType<typeof fakeClaude>,
  launch: Partial<ClaudeStructuredLaunch> = {}
) {
  const events: ClaudeStructuredSessionEvent[] = []
  const adapter = adapterAtPublishFor(claude, launch, events)
  const opens: Promise<unknown>[] = []
  owned.push({ claude, adapter, opens })
  const open = adapter.open.bind(adapter)
  adapter.open = (request) => {
    const result = open(request)
    void result.catch(() => {})
    opens.push(result)
    return result
  }
  return { adapter, events }
}

describe('Claude host-awaited open', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    try {
      for (const { claude } of owned) {
        claude.dispose()
      }
      for (const { adapter, opens } of owned.splice(0)) {
        await Promise.allSettled(opens)
        await adapter.closeAll()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an open Stop aborted to Stop when Claude then reports a startup failure', async () => {
    const claude = fakeClaude({ holdInit: true, initProof: 'none' })
    const { adapter } = adapterFor(claude)
    const appendItem = vi.fn()
    const acquisition = await adapter.acquire({
      ...ACQUIRE,
      events: { ...recordingJournalSink(), appendItem }
    })
    const controller = new AbortController()
    const open = adapter.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: controller.signal
    })
    controller.abort(new Error('stopped by the person'))
    claudeFrame(claude.connections[0]!, { ...MISSING, session_id: PROVIDER_SESSION_ID })
    await expect(open).rejects.toThrow('stopped by the person')
    expect(errorRows(appendItem)).toHaveLength(0)
  })

  // SDK-typed shape; ordering constructed
})
