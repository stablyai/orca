import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adapterAtPublishFor,
  fakeClaude,
  claudeFrame,
  identityFor,
  recordingJournalSink,
  USER_MESSAGE,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { claudeOpened } from './claude-structured-startup-settled-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import type { ClaudeStructuredLaunch } from './launch/claude-structured-launch-resolution'

const owned: {
  claude: ReturnType<typeof fakeClaude>
  adapter: ReturnType<typeof adapterAtPublishFor>
  opens: Promise<unknown>[]
}[] = []

const ACQUIRE = { identity: identityFor(), fence: 7, spawnToken: 'spawn-9' }

const fixture = (name: string): Record<string, unknown>[] =>
  readFileSync(new URL(`../__fixtures__/${name}.jsonl`, import.meta.url), 'utf8')
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

  // Recorded result; the orderings are constructed. A start another failure ended reports that cause.

  // Whichever ends the start first is its report: a hidden result is the open's error, else its row stays.

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

  it('returns from open without waiting for optional settings', async () => {
    let answerSettings: (value: unknown) => void = () => {}
    const settings = new Promise<unknown>((resolve) => {
      answerSettings = resolve
    })
    const claude = fakeClaude({ settings })
    const { adapter, events } = adapterFor(claude)
    try {
      await adapter.acquire(ACQUIRE)
      const opened = await claudeOpened(adapter, 'session-1')
      expect(opened.reportedOptions).toBeDefined()
      expect(claude.connections[0].calls.map((call) => call.subtype)).toContain('get_settings')
      expect(events.some((event) => event.type === 'options-reported')).toBe(false)
      answerSettings({ applied: { model: 'claude-haiku-4-5' }, effective: {} })
      await vi.waitFor(() =>
        expect(events.find((event) => event.type === 'options-reported')).toMatchObject({
          reportedOptions: { model: 'claude-haiku-4-5' }
        })
      )
      await adapter.closeAll()
    } finally {
      answerSettings({})
    }
  })

  it('opens a healthy Claude session whose initialize takes longer than a minute', async () => {
    const claude = fakeClaude({ initDelayMs: 75_000 })
    const { adapter } = adapterFor(claude)
    await adapter.acquire(ACQUIRE)
    const opened = expect(claudeOpened(adapter, 'session-1')).resolves.toMatchObject({
      reportedOptions: expect.any(Object)
    })
    await vi.advanceTimersByTimeAsync(75_000)
    await opened
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'slow-start',
        body: USER_MESSAGE
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    expect(claude.connections[0].sent).toMatchObject([
      { message: { content: [{ type: 'text', text: 'ship it' }] } }
    ])
  })

  it('lets the host abort a silent initialize wait and close the owned process', async () => {
    const claude = fakeClaude({ initDelayMs: 12_000 })
    const { adapter } = adapterFor(claude)
    const acquisition = await adapter.acquire(ACQUIRE)
    const controller = new AbortController()
    const open = adapter.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquisition.acquisitionGeneration,
      signal: controller.signal
    })
    controller.abort(new Error('host start expired'))
    await expect(open).rejects.toThrow('host start expired')
    await adapter.closeSession('session-1')
    expect(claude.connections[0].closeCount).toBe(1)
  })
})
