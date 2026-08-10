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
