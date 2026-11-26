import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CONNECTOR_REPLY_HTML_PAGE_AS_FILE } from '../../shared/rpc-contract/connectors/connector-params'
import { dispatch, type HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'

const HTML = '  ~~~~` \tHTML title\r\n<!doctype html>\r\n<html><body>Report</body></html>\r\n  ~~~~'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'
const POSTED = {
  id: 'reply',
  ok: true as const,
  result: { status: 'posted' },
  _meta: { runtimeId: 'test-runtime' }
}

type ReplyTransport = (method: string, params: unknown) => Promise<typeof POSTED>

function dispatchReply(text: string, call: ReplyTransport) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bot reply uses only call.
  const client = { call } as unknown as HandlerContext['client']
  return dispatch(['bot', 'reply'], {
    client,
    cwd: process.cwd(),
    json: false,
    flags: new Map([['text', text]])
  })
}

beforeEach(() => {
  vi.stubEnv('ORCA_AGENT_SESSION_ID', SESSION_ID)
  vi.stubEnv('ORCA_PANE_KEY', undefined)
  vi.stubEnv('ORCA_AGENT_PANE', undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('sends typed prose without opting in to HTML attachments', async () => {
  const text = 'The report is ready.\n```ts\nconst format = "html"\n```'
  const call = vi.fn<ReplyTransport>().mockResolvedValueOnce(POSTED)

  await dispatchReply(text, call)

  expect(call.mock.calls.map(([method, params]) => [method, params])).toStrictEqual([
    ['connector.reply', { sessionId: SESSION_ID, replyId: expect.any(String), text }]
  ])
})

it('opts in for an HTML page and retries inline after staging fails before posting', async () => {
  const call = vi
    .fn<ReplyTransport>()
    .mockRejectedValueOnce(
      new RuntimeClientError(CONNECTOR_REPLY_HTML_PAGE_AS_FILE, 'Attach the HTML page')
    )
    .mockRejectedValueOnce(new Error('staging unavailable'))
    .mockResolvedValueOnce(POSTED)

  await dispatchReply(HTML, call)

  expect(call.mock.calls.map(([method, params]) => [method, params])).toStrictEqual([
    [
      'connector.reply',
      { sessionId: SESSION_ID, replyId: expect.any(String), text: HTML, pagesAsFiles: true }
    ],
    [
      'connector.act',
      {
        sessionId: SESSION_ID,
        verb: 'reply',
        args: {
          upload: { name: 'page.html', size: expect.any(Number) },
          stage: true,
          postId: expect.any(String)
        }
      }
    ],
    ['connector.reply', { sessionId: SESSION_ID, replyId: expect.any(String), text: HTML }]
  ])
})
