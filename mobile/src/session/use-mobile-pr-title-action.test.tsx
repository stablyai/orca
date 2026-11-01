import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'
import { useMobilePrTitleAction, type MobilePrTitleAction } from './use-mobile-pr-title-action'

describe('useMobilePrTitleAction', () => {
  it('rereads after every attempted save while the write decides the result', async () => {
    const updateTitle = vi.fn<() => Promise<GitHubPrMutationOutcome>>()
    const refetch = vi.fn<() => Promise<void>>()
    let latest: MobilePrTitleAction | null = null
    function Probe() {
      latest = useMobilePrTitleAction({
        client: null,
        connState: 'connected',
        worktreeId: 'wt-1',
        prNumber: 7,
        refetch,
        mutations: { updateTitle }
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })

    updateTitle.mockResolvedValueOnce({ ok: false, error: 'connection lost' })
    refetch.mockResolvedValueOnce(undefined)
    let saved: boolean | undefined
    await act(async () => {
      saved = await latest!.setTitle('New title', 'Old title')
    })
    expect(saved).toBe(false)
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(latest!.error).toBe('connection lost')

    updateTitle.mockResolvedValueOnce({ ok: true })
    refetch.mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => {
      saved = await latest!.setTitle('New title', 'Old title')
    })
    expect(saved).toBe(true)
    expect(refetch).toHaveBeenCalledTimes(2)
    expect(latest!.error).toBeNull()
  })
})
