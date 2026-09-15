import { describe, expect, it, vi } from 'vitest'
import { useMobileTasksItemDetailLoading } from './use-mobile-tasks-item-detail-loading'

vi.mock('./mobile-tasks-dependencies', () => ({ useEffect: (effect: () => void) => effect() }))
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  isSuccess: (response: { ok: boolean }) => response.ok
}))

describe('Linear detail settlement', () => {
  it('b3: comments transport error wins over an issue refusal after the raw barrier', async () => {
    let refuseIssue!: (reply: unknown) => void
    let rejectComments!: (error: Error) => void
    const issue = new Promise((resolve) => {
      refuseIssue = resolve
    })
    const comments = new Promise((_resolve, reject) => {
      rejectComments = reject
    })
    const sendRequest = vi.fn((method: string) => (method === 'linear.getIssue' ? issue : comments))
    const setDetailError = vi.fn()
    const setDetailLoading = vi.fn()
    const setDetailPayload = vi.fn()
    useMobileTasksItemDetailLoading({
      client: { sendRequest },
      tasksSupported: true,
      actionItem: { provider: 'linear', source: { id: 'issue-1', workspaceId: 'workspace-1' } },
      setDetailError,
      setDetailLoading,
      setDetailPayload,
      setActionItem: vi.fn(),
      setItems: vi.fn()
    } as unknown as Parameters<typeof useMobileTasksItemDetailLoading>[0])
    refuseIssue({ ok: false, error: { message: 'issue refused' } })
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
    }
    expect(setDetailError).toHaveBeenLastCalledWith('')
    expect(setDetailLoading).toHaveBeenLastCalledWith(true)
    rejectComments(new Error('comments transport failed'))
    for (let i = 0; i < 8; i++) {
      await Promise.resolve()
    }
    expect(setDetailError).toHaveBeenLastCalledWith('comments transport failed')
    expect(setDetailLoading).toHaveBeenLastCalledWith(false)
    expect(setDetailPayload).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
