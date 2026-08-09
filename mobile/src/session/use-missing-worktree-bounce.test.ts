import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeShowResolution } from '../worktree/worktree-show-resolution'
import { isSyntheticWorkspaceRoute } from './synthetic-workspace-route'
import {
  shouldBounceMissingWorktree,
  useMissingWorktreeBounce
} from './use-missing-worktree-bounce'

describe('shouldBounceMissingWorktree', () => {
  it('bounces only a host-proven missing worktree', () => {
    expect(shouldBounceMissingWorktree('repo::wt', 'missing')).toBe(true)
    expect(shouldBounceMissingWorktree('repo::wt', 'unknown')).toBe(false)
    expect(shouldBounceMissingWorktree('repo::wt', 'present')).toBe(false)
  })

  it('never bounces synthetic routes the host cannot resolve', () => {
    expect(isSyntheticWorkspaceRoute('folder:/Users/x/dir')).toBe(true)
    expect(shouldBounceMissingWorktree('folder:/Users/x/dir', 'missing')).toBe(false)
    expect(shouldBounceMissingWorktree('global-floating-terminal', 'missing')).toBe(false)
  })
})

describe('useMissingWorktreeBounce', () => {
  let renderer: ReactTestRenderer | null = null
  const bounce = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    bounce.mockReset()
    renderer = null
  })

  function Harness(props: { worktreeId: string; resolution: WorktreeShowResolution }): null {
    useMissingWorktreeBounce({
      hostId: 'host-1',
      worktreeId: props.worktreeId,
      resolution: props.resolution,
      bounce
    })
    return null
  }

  function render(worktreeId: string, resolution: WorktreeShowResolution): void {
    act(() => {
      const element = createElement(Harness, { worktreeId, resolution })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it('bounces exactly once per worktree even across re-renders', () => {
    render('repo::wt', 'unknown')
    expect(bounce).not.toHaveBeenCalled()

    render('repo::wt', 'missing')
    expect(bounce).toHaveBeenCalledExactlyOnceWith('host-1')

    // Why: navigation lands after the render, so the pre-unmount renders must not re-fire.
    render('repo::wt', 'missing')
    expect(bounce).toHaveBeenCalledTimes(1)
    act(() => renderer?.unmount())
  })

  it('re-arms for a different worktree on the reused screen', () => {
    render('repo::wt-1', 'missing')
    expect(bounce).toHaveBeenCalledTimes(1)

    render('repo::wt-2', 'unknown')
    expect(bounce).toHaveBeenCalledTimes(1)
    render('repo::wt-2', 'missing')
    expect(bounce).toHaveBeenCalledTimes(2)
    act(() => renderer?.unmount())
  })
})
