import { expect, it, vi } from 'vitest'

import { TRAE_FIXTURE_SESSION_ID, traeFixture } from './session-scanner-trae-fixtures'
import { parseTraeSessionContent } from './session-scanner-trae-parser'

it('parses installed Trae rollouts without a metadata session id', async () => {
  const fixture = traeFixture()
  const readIndexedTitle = vi.fn(async () => 'Indexed Trae title')
  const session = await parseTraeSessionContent({
    file: {
      path: `/fixtures/2026/08/10/${fixture.fileName}`,
      mtimeMs: 0,
      modifiedAt: '2026-08-10T10:04:00.000Z'
    },
    content: [
      ...fixture.seedLines,
      '{malformed-json',
      JSON.stringify({
        timestamp: '2026-08-10T10:03:30.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
          }
        }
      }),
      ...fixture.appendLines
    ].join('\n'),
    platform: 'darwin',
    readIndexedTitle
  })

  expect(readIndexedTitle).toHaveBeenCalledWith(TRAE_FIXTURE_SESSION_ID)
  expect(session).toMatchObject({
    agent: 'trae',
    sessionId: TRAE_FIXTURE_SESSION_ID,
    cwd: '/repo/trae',
    model: 'trae-model',
    title: 'Indexed Trae title',
    totalTokens: 150,
    messageCount: 2,
    codexHome: null,
    previewMessages: [
      { role: 'user', text: 'Trae seed question' },
      { role: 'assistant', text: 'Trae incremental answer' }
    ]
  })
})

it('keeps the Trae session metadata cwd when later turns use another directory', async () => {
  const session = await parseTraeSessionContent({
    file: {
      path: `/fixtures/rollout-${TRAE_FIXTURE_SESSION_ID}.jsonl`,
      mtimeMs: 0,
      modifiedAt: '2026-08-10T10:04:00.000Z'
    },
    content: [
      {
        timestamp: '2026-08-10T10:00:00.000Z',
        type: 'session_meta',
        payload: { cwd: '/repo/original' }
      },
      {
        timestamp: '2026-08-10T10:01:00.000Z',
        type: 'turn_context',
        payload: { cwd: '/repo/later-turn', model: 'trae-model' }
      },
      {
        timestamp: '2026-08-10T10:01:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Keep the original workspace' }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n'),
    platform: 'darwin'
  })

  expect(session).toMatchObject({
    cwd: '/repo/original',
    resumeCommand: "cd '/repo/original' && traecli resume '019fe968-ff04-7e43-8316-983ae577b782'"
  })
})
