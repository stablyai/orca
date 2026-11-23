import { beforeEach, describe, expect, it, vi } from 'vitest'

const clickupRequest =
  vi.fn<(token: string, path: string, init?: RequestInit) => Promise<unknown>>()

vi.mock('./authenticated-request', () => ({ clickupRequest }))
type Context = { token: string; workspaceId: string; signal: AbortSignal }
const withClickUpContext =
  vi.fn<(run: (context: Context) => Promise<unknown>) => Promise<unknown>>()

vi.mock('./client', () => ({ withClickUpContext }))

beforeEach(() => {
  clickupRequest.mockReset()
  withClickUpContext.mockReset()
  withClickUpContext.mockImplementation(async (run) =>
    run({ token: 'token', workspaceId: '9001', signal: new AbortController().signal })
  )
})

describe('addTaskComment failures', () => {
  it('tells the user to check the thread when the request or its response was lost', async () => {
    const { addTaskComment } = await import('./clickup-task-mutations')
    clickupRequest.mockRejectedValue(new TypeError('fetch failed'))

    const result = await addTaskComment('86abc12de', 'hello')

    expect(result).toEqual({
      ok: false,
      error:
        'ClickUp may have saved the comment even though the request failed (fetch failed). Check the thread before trying again.'
    })
  })

  it('keeps a ClickUp rejection as it is, since nothing was saved', async () => {
    const { addTaskComment } = await import('./clickup-task-mutations')
    const { ClickUpApiError } = await import('./clickup-api-error')
    clickupRequest.mockRejectedValue(new ClickUpApiError('Comment is too long', 400, 'ITEM_001'))

    await expect(addTaskComment('86abc12de', 'hello')).resolves.toEqual({
      ok: false,
      error: 'Comment is too long'
    })
  })

  it('keeps the deadline message, which already warns about retrying', async () => {
    const { addTaskComment } = await import('./clickup-task-mutations')
    const { ClickUpApiError } = await import('./clickup-api-error')
    clickupRequest.mockRejectedValue(
      new ClickUpApiError(
        "ClickUp didn't confirm in time. Check the task before trying again.",
        null,
        'TIMEOUT'
      )
    )

    await expect(addTaskComment('86abc12de', 'hello')).resolves.toEqual({
      ok: false,
      error: "ClickUp didn't confirm in time. Check the task before trying again."
    })
  })

  it('surfaces a failure before the comment was sent as it is', async () => {
    const { addTaskComment } = await import('./clickup-task-mutations')
    withClickUpContext.mockRejectedValue(new Error('The stored ClickUp token cannot be decrypted.'))

    await expect(addTaskComment('86abc12de', 'hello')).resolves.toEqual({
      ok: false,
      error: 'The stored ClickUp token cannot be decrypted.'
    })
    expect(clickupRequest).not.toHaveBeenCalled()
  })
})
