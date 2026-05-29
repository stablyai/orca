import { describe, expect, it, vi } from 'vitest'
import { subscribeDockerBuildProgress } from './docker-build-progress-subscription'

describe('subscribeDockerBuildProgress', () => {
  it('removes the exact build-progress listener on cleanup', () => {
    const on = vi.fn()
    const removeListener = vi.fn()
    const callback = vi.fn()

    const cleanup = subscribeDockerBuildProgress({ on, removeListener } as never, callback)

    expect(on).toHaveBeenCalledWith('docker:build-progress', expect.any(Function))
    const listener = on.mock.calls[0]?.[1]
    listener(null, { worktreeId: 'wt-1', phase: 'build', percent: 40 })
    expect(callback).toHaveBeenCalledWith({ worktreeId: 'wt-1', phase: 'build', percent: 40 })

    cleanup()

    expect(removeListener).toHaveBeenCalledWith('docker:build-progress', listener)
  })
})
