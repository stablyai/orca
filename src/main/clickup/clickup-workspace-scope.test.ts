import { beforeEach, describe, expect, it, vi } from 'vitest'

const clickupRequest = vi.fn<(token: string, path: string) => Promise<unknown>>()

vi.mock('./authenticated-request', () => ({ clickupRequest }))
vi.mock('./client', () => ({
  withClickUpContext: async (
    run: (context: {
      token: string
      viewer: null
      workspaceId: string
      signal: AbortSignal
    }) => Promise<unknown>
  ) =>
    run({ token: 'token', viewer: null, workspaceId: '9001', signal: new AbortController().signal })
}))

const FILTER = { scope: 'all', includeClosed: false } as const

beforeEach(() => {
  clickupRequest.mockReset()
  clickupRequest.mockResolvedValue({ tasks: [], last_page: true })
})

describe('reads that name a Workspace', () => {
  it('rejects a list read for a Workspace other than the selected one without calling ClickUp', async () => {
    const { listTasks } = await import('./clickup-task-queries')

    await expect(listTasks(FILTER, 0, '7777')).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    expect(clickupRequest).not.toHaveBeenCalled()
  })

  it('rejects a text search for a Workspace other than the selected one without calling ClickUp', async () => {
    const { searchTasks } = await import('./clickup-task-queries')

    await expect(searchTasks('login', FILTER, undefined, false, '7777')).rejects.toMatchObject({
      code: 'WORKSPACE_CHANGED'
    })
    expect(clickupRequest).not.toHaveBeenCalled()
  })
})
