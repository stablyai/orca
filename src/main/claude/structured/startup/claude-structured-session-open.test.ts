import { afterEach, expect, it, vi } from 'vitest'
import * as jsonlImport from '../../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import * as transcriptCatchUp from '../../transcripts/claude-transcript-catch-up'
import {
  chat,
  closeClaudeCatchUpChats,
  SESSION,
  PROVIDER
} from '../../transcripts/claude-transcript-catch-up.test-support'
import {
  adapterAtPublishFor,
  fakeClaude,
  identityFor
} from '../claude-structured-session-test-support'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
  await closeClaudeCatchUpChats()
})

async function openWithBlockedRecovery() {
  const c = await chat('batch')
  const claude = fakeClaude({ initSessionId: PROVIDER })
  const adapter = adapterAtPublishFor(claude, {
    providerSessionId: PROVIDER,
    resumeLeafUuid: 'old-leaf',
    resumesTranscript: true,
    cwd: c.cwd,
    claudeConfigDir: c.config
  })
  const blocked = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<transcriptCatchUp.ClaudeTranscriptCatchUpOutcome>()
  const prepare = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await prepare(input)
    blocked.resolve(input.signal!)
    await release.promise
    return prepared
  })
  const catchUp = transcriptCatchUp.catchUpClaudeTranscript
  vi.spyOn(transcriptCatchUp, 'catchUpClaudeTranscript').mockImplementation(async (input) => {
    const outcome = await catchUp(input)
    if (input.mode === 'recovery') {
      finished.resolve(outcome)
    }
    return outcome
  })
  let opened: Promise<unknown> | undefined
  cleanups.push(async () => {
    release.resolve()
    await opened?.catch(() => {})
    await adapter.closeAll()
    claude.dispose()
  })
  const acquired = await adapter.acquire({
    identity: identityFor(SESSION),
    fence: 1,
    spawnToken: 'catch-up-open',
    events: c.deferred.sink
  })
  opened = adapter.open({
    sessionId: SESSION,
    fence: 1,
    acquisitionGeneration: acquired.acquisitionGeneration,
    signal: new AbortController().signal
  })
  return { ...c, adapter, opened, blocked: blocked.promise, release, finished: finished.promise }
}

it('opens the chat while capacity recovery is blocked, then installs the recent history', async () => {
  const c = await openWithBlockedRecovery()
  await c.blocked
  await expect(c.opened).resolves.toMatchObject({ newConversation: false })
  expect(await c.items()).not.toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ presentation: 'continued-outside-recent' })
    })
  )
  c.release.resolve()
  expect(await c.finished).toBe(true)
  const items = await c.items()
  expect(items).toContainEqual(
    expect.objectContaining({
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Distinctive newest outside answer' }]
      }
    })
  )
  expect(items).toContainEqual(
    expect.objectContaining({
      body: expect.objectContaining({ presentation: 'continued-outside-recent' })
    })
  )
})

it.each(['dispatch', 'close'] as const)(
  'drops blocked capacity recovery when a live %s follows open',
  async (action) => {
    const c = await openWithBlockedRecovery()
    const signal = await c.blocked
    await c.opened
    await (action === 'dispatch'
      ? expect(
          c.adapter.dispatch({
            sessionId: SESSION,
            fence: 1,
            clientMessageId: 'live-prompt',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Keep my live turn' }]
            }
          })
        ).resolves.toMatchObject({ state: 'admitted' })
      : c.adapter.closeAll())
    expect(signal.aborted).toBe(true)
    await c.deferred.sink.written?.()
    const cursor = await c.journal.reads.physicalCursor()
    c.release.resolve()
    expect(await c.finished).toBe(false)
    await c.deferred.sink.written?.()
    expect(await c.journal.reads.physicalCursor()).toEqual(cursor)
    expect(await c.items()).not.toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ presentation: 'continued-outside-recent' })
      })
    )
  }
)
