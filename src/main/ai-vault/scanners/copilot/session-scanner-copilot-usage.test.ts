import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCopilotSessionResumeState } from './session-scanner-copilot-parser'
import { SessionParseCacheDatabase } from '../../parse-cache/session-parse-cache-database'
import { writePreviousSessionParseRows } from '../../parse-cache/session-parse-cache-previous-row.test-fixture'

it('counts model input and output once without adding context or cache subsets', async () => {
  const state = createCopilotSessionResumeState({
    path: '/tmp/copilot-session/events.jsonl',
    mtimeMs: 1784109600000,
    modifiedAt: '2026-07-15T10:00:00.000Z'
  })
  state.consumeLine(JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }))
  state.consumeLine(
    JSON.stringify({
      type: 'session.shutdown',
      data: {
        currentTokens: 27176,
        modelMetrics: {
          'claude-sonnet-5': {
            usage: {
              inputTokens: 71282,
              outputTokens: 345,
              cacheReadTokens: 35495,
              cacheWriteTokens: 35783,
              reasoningTokens: 31
            }
          },
          'other-model': { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } }
        }
      }
    })
  )
  expect((await state.finalize('linux'))?.totalTokens).toBe(71747)
  state.consumeLine(
    JSON.stringify({ type: 'session.shutdown', data: { modelMetrics: {}, currentTokens: 500 } })
  )
  expect((await state.finalize('linux'))?.totalTokens).toBe(71747)
  state.consumeLine(JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 340 } }))
  expect((await state.finalize('linux'))?.totalTokens).toBe(72087)
})

it('reparses persisted Copilot totals once without discarding unrelated session rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-copilot-usage-cache-'))
  const path = join(root, 'session-parse-cache.sqlite')
  const state = createCopilotSessionResumeState({
    path: join(root, 'events.jsonl'),
    mtimeMs: 1784109600000,
    modifiedAt: '2026-07-15T10:00:00.000Z'
  })
  state.consumeLine(JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }))
  state.consumeLine(
    JSON.stringify({
      type: 'session.shutdown',
      data: {
        currentTokens: 50,
        modelMetrics: { model: { usage: { inputTokens: 100, outputTokens: 20 } } }
      }
    })
  )
  const session = await state.finalize('linux')
  if (!session) {
    throw new Error('The transcript fixture must produce a session')
  }
  const entry = { mtimeMs: 1784109600000, sizeBytes: 100, platform: 'linux' as const, session }
  const unrelated = { ...entry, session: { ...session, agent: 'claude' as const } }
  let db: SessionParseCacheDatabase | undefined
  try {
    writePreviousSessionParseRows(path, [
      ['copilot', { ...entry, session: { ...session, totalTokens: 170 } }],
      ['unrelated', unrelated]
    ])
    db = new SessionParseCacheDatabase(path)
    expect(db.read('copilot')).toBeUndefined()
    expect(db.read('unrelated')?.session).toEqual(unrelated.session)
    db.write([['copilot', entry]], 1784109600000)
    db.close()
    db = new SessionParseCacheDatabase(path)
    expect(db.read('copilot')?.session?.totalTokens).toBe(120)
  } finally {
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
})
