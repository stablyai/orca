import { beforeEach, expect, it, vi } from 'vitest'

const clickupRequest = vi.fn<(token: string, path: string) => Promise<unknown>>()

vi.mock('./authenticated-request', () => ({ clickupRequest }))
vi.mock('./client', () => ({
  withClickUpContext: async (
    run: (context: { token: string; workspaceId: string; signal: AbortSignal }) => Promise<unknown>
  ) => run({ token: 'token', workspaceId: '9001', signal: new AbortController().signal })
}))

function comments(ids: string[], date: number) {
  return { comments: ids.map((id) => ({ id, comment_text: id, date: String(date) })) }
}

beforeEach(() => {
  clickupRequest.mockReset()
})

it('pages from the last comment of a response when timestamps are equal', async () => {
  const { getTaskComments } = await import('./clickup-task-queries')
  const firstPage = Array.from({ length: 25 }, (_, index) => `c${index + 1}`)
  clickupRequest
    .mockResolvedValueOnce(comments(firstPage, 1_700_000_000_000))
    .mockResolvedValueOnce(comments(['c26'], 1_699_999_999_000))

  const all = await getTaskComments('86abc12de')

  const secondPath = clickupRequest.mock.calls[1][1]
  expect(Object.fromEntries(new URLSearchParams(secondPath.split('?')[1]))).toEqual({
    start: '1700000000000',
    start_id: 'c25'
  })
  expect(all).toHaveLength(26)
})
