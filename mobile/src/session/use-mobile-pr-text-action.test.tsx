import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import { useMobilePrTextAction, type MobilePrTextAction } from './use-mobile-pr-text-action'

describe('useMobilePrTextAction', () => {
  it('rereads after every attempted save while the write decides the result', async () => {
    const updateBody = vi.fn<() => Promise<GitHubPrMutationOutcome>>()
    const refetch = vi.fn<() => Promise<void>>()
    let latest: MobilePrTextAction | null = null
    function Probe() {
      latest = useMobilePrTextAction({
        client: null,
        connState: 'connected',
        worktreeId: 'wt-1',
        prNumber: 7,
        refetch,
        mutations: { updateTitle: vi.fn(), updateBody }
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })

    updateBody.mockResolvedValueOnce({ ok: false, error: 'connection lost' })
    refetch.mockResolvedValueOnce(undefined)
    let saved: boolean | undefined
    await act(async () => {
      saved = await latest!.save('body', 'New body', 'Old body')
    })
    expect(saved).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(latest!.error).toBe('connection lost')

    updateBody.mockResolvedValueOnce({ ok: true })
    refetch.mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => {
      saved = await latest!.save('body', 'New body', 'Old body')
    })
    expect(saved).toBe(true)
    expect(refetch).toHaveBeenCalledTimes(2)
    expect(latest!.error).toBeNull()
  })
})
