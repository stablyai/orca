import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostSessionMarkdownDraft,
  HostSessionMarkdownOperations,
  HostSessionMarkdownTarget
} from './host-session-markdown-operations'
import {
  MobileSessionMarkdownDraftCoordinator,
  restoreMobileSessionMarkdownDraft
} from './mobile-session-markdown-draft-coordinator'

const TARGET: HostSessionMarkdownTarget = {
  workspaceId: 'workspace-a',
  tabId: 'tab-a',
  relativePath: 'notes.md'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mobile session markdown draft coordinator', () => {
  it('restores a stale draft without rebasing it onto newer host content', () => {
    const restored = restoreMobileSessionMarkdownDraft(
      {
        status: 'ready',
        content: 'host v2',
        localContent: 'host v2',
        baseVersion: 'v2',
        isDirty: false,
        editable: true
      },
      { content: 'phone draft', baseVersion: 'v1' }
    )

    expect(restored).toMatchObject({
      content: 'host v2',
      localContent: 'phone draft',
      baseVersion: 'v1',
      isDirty: true,
      stale: true
    })
  })

  it('does not let late hydration replace a user edit', async () => {
    let resolveLoad: (draft: HostSessionMarkdownDraft | null) => void = () => undefined
    const operations = markdownOperations({
      loadDraft: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    })
    const coordinator = new MobileSessionMarkdownDraftCoordinator(operations)
    const apply = vi.fn()

    const hydration = coordinator.hydrate(TARGET, apply)
    coordinator.markEdited(TARGET)
    resolveLoad({ content: 'stored', baseVersion: 'v1' })
    await hydration

    expect(apply).not.toHaveBeenCalled()
    expect(coordinator.isHydrated(TARGET)).toBe(true)
  })

  it('serializes clear after an in-flight debounced write', async () => {
    vi.useFakeTimers()
    let releaseWrite: () => void = () => undefined
    const saveDraft = vi
      .fn<HostSessionMarkdownOperations['saveDraft']>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
      )
      .mockResolvedValue(undefined)
    const coordinator = new MobileSessionMarkdownDraftCoordinator(
      markdownOperations({ saveDraft }),
      10
    )
    coordinator.markEdited(TARGET)
    coordinator.scheduleSave(TARGET, { content: 'draft', baseVersion: 'v1' })
    await vi.advanceTimersByTimeAsync(10)

    const clearing = coordinator.clear(TARGET)
    expect(saveDraft).toHaveBeenCalledTimes(1)
    releaseWrite()
    await clearing

    expect(saveDraft).toHaveBeenNthCalledWith(1, TARGET, {
      content: 'draft',
      baseVersion: 'v1'
    })
    expect(saveDraft).toHaveBeenNthCalledWith(2, TARGET, null)
  })
})

function markdownOperations(
  overrides: Partial<HostSessionMarkdownOperations> = {}
): HostSessionMarkdownOperations {
  return {
    readTab: vi.fn(),
    saveTab: vi.fn(),
    loadDraft: vi.fn().mockResolvedValue(null),
    saveDraft: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}
