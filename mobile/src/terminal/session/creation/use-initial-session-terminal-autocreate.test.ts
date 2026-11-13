import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorktreeSessionTabsLoaded } from './use-initial-session-terminal-autocreate'

describe('useWorktreeSessionTabsLoaded', () => {
  let renderer: ReactTestRenderer | null = null
  let current: readonly [boolean, (loaded: boolean) => void] | null = null

  function Harness({ worktreeId }: { worktreeId: string }): null {
    current = useWorktreeSessionTabsLoaded(worktreeId)
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    current = null
  })

  it('does not carry a loaded snapshot across a reused route', async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { worktreeId: 'existing' }))
    })
    act(() => current?.[1](true))
    expect(current?.[0]).toBe(true)

    await act(async () => {
      renderer?.update(createElement(Harness, { worktreeId: 'new' }))
    })
    expect(current?.[0]).toBe(false)
  })
})
