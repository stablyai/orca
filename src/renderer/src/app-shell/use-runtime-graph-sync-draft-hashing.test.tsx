// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'

const mocks = vi.hoisted(() => ({
  getState: vi.fn<() => AppState>(),
  subscribe: vi.fn((_listener: (state: AppState, previous: AppState) => void) => () => {}),
  publish: vi.fn<() => Promise<void>>(),
  hashes: { calls: 0, chars: 0 }
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: AppState) => unknown) => selector(mocks.getState()),
    {
      getState: mocks.getState,
      subscribe: mocks.subscribe
    }
  )
}))
vi.mock('../runtime/sync-runtime-graph/graph-publication', () => ({
  syncRuntimeGraph: mocks.publish,
  setTrailingGraphSyncScheduler: vi.fn()
}))
vi.mock('../runtime/sync-runtime-graph/editor-draft-hash', async (importOriginal) => {
  const actual = await importOriginal<{ stableHashString: typeof stableHashString }>()
  return {
    stableHashString: (text: string) => {
      mocks.hashes.calls += 1
      mocks.hashes.chars += text.length
      return actual.stableHashString(text)
    }
  }
})

import { useRuntimeGraphSync } from './use-runtime-graph-sync'
import { graphState } from '../runtime/sync-runtime-graph/graph-state'
import { buildMobileSessionTabSnapshots } from '../runtime/sync-runtime-graph/mobile-session-snapshots'
import { resetRuntimeMobileSyncProjectionCachesForTests } from '../runtime/sync-runtime-graph/sync-projections'
import { stableHashString } from '../runtime/sync-runtime-graph/editor-draft-hash'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

function Probe({ revision: _revision }: { revision: number }): null {
  useRuntimeGraphSync()
  return null
}

const file = {
  id: 'markdown',
  filePath: '/repo/README.md',
  relativePath: 'README.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit' as const,
  isDirty: true
}

describe('runtime graph draft hashing at publication', () => {
  let root: Root
  let store: ReturnType<typeof createTestStore>
  let snapshots: RuntimeMobileSessionTabsSnapshot[][]
  let revision = 0
  let releasePublication: (() => void) | undefined

  async function render(): Promise<void> {
    revision += 1
    await act(async () => root.render(<Probe revision={revision} />))
  }
  async function flush(): Promise<void> {
    await act(async () => vi.advanceTimersByTimeAsync(16))
  }
  function latestVersion(): string | undefined {
    return snapshots
      .at(-1)
      ?.flatMap((snapshot) => snapshot.tabs)
      .find((tab) => tab.type === 'markdown')?.documentVersion
  }
  function resetCounts(): void {
    mocks.hashes.calls = 0
    mocks.hashes.chars = 0
    mocks.publish.mockClear()
    snapshots = []
  }
  beforeEach(() => {
    releasePublication = undefined
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    resetRuntimeMobileSyncProjectionCachesForTests()
    graphState.mobileSessionSnapshotCacheByWorktree.clear()
    store = createTestStore()
    store.setState({
      workspaceSessionReady: true,
      openFiles: [file],
      editorDrafts: { markdown: 'initial' }
    })
    mocks.getState.mockImplementation(store.getState)
    mocks.subscribe.mockImplementation(store.subscribe)
    snapshots = []
    mocks.publish.mockImplementation(async () => {
      snapshots.push(buildMobileSessionTabSnapshots(store.getState(), false))
    })
    resetCounts()
    root = createRoot(document.createElement('div'))
  })
  afterEach(async () => {
    await act(async () => {
      root.unmount()
      releasePublication?.()
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([40_000, 400_000])(
    'hashes only the final %i-character Markdown draft in a burst',
    async (size) => {
      store.setState({ editorDrafts: { markdown: 'x'.repeat(size) } })
      await render()
      await flush()
      resetCounts()
      for (let index = 1; index <= 100; index += 1) {
        store.getState().setEditorDraft(file.id, 'x'.repeat(size + index))
      }
      expect(mocks.hashes.calls).toBe(0)
      expect(mocks.publish).not.toHaveBeenCalled()
      await flush()
      expect(mocks.hashes).toEqual({ calls: 1, chars: size + 100 })
      expect(mocks.publish).toHaveBeenCalledTimes(1)
      const version = stableHashString(store.getState().editorDrafts.markdown)
      expect(latestVersion()).toBe(version)
      resetCounts()
      store.setState({ editorDrafts: { ...store.getState().editorDrafts } })
      await flush()
      expect(mocks.publish).not.toHaveBeenCalled()
      expect(mocks.hashes.calls).toBe(0)
    }
  )

  it('defers disabled edits until re-enable and cancels pending work on unmount', async () => {
    store.setState({ workspaceSessionReady: false })
    await render()
    resetCounts()
    for (let index = 0; index < 100; index += 1) {
      store.getState().setEditorDraft(file.id, `disabled-${index}`)
    }
    await flush()
    expect(mocks.hashes.calls).toBe(0)
    expect(mocks.publish).not.toHaveBeenCalled()
    store.setState({ workspaceSessionReady: true })
    await render()
    await flush()
    expect(latestVersion()).toBe(stableHashString('disabled-99'))
    resetCounts()
    store.getState().setEditorDraft(file.id, 'retired')
    await act(async () => root.render(null))
    await flush()
    expect(mocks.hashes.calls).toBe(0)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes a trailing edit after an in-flight publication resolves', async () => {
    await render()
    await flush()
    resetCounts()
    mocks.publish.mockImplementationOnce(async () => {
      snapshots.push(buildMobileSessionTabSnapshots(store.getState(), false))
      await new Promise<void>((resolve) => {
        releasePublication = resolve
      })
    })
    store.getState().setEditorDraft(file.id, 'first')
    await flush()
    expect(latestVersion()).toBe(stableHashString('first'))
    resetCounts()
    store.setState({ workspaceSessionReady: false })
    await render()
    store.getState().setEditorDraft(file.id, 'last')
    await flush()
    expect(mocks.hashes.calls).toBe(0)
    expect(mocks.publish).not.toHaveBeenCalled()
    store.setState({ workspaceSessionReady: true })
    await render()
    await act(async () => releasePublication?.())
    await flush()
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(latestVersion()).toBe(stableHashString('last'))
  })

  it('retains preview-source admission, meaningful clear, and Markdown eligibility changes', async () => {
    const source = { ...file, id: 'source', language: 'typescript', filePath: '/repo/source.ts' }
    const preview = {
      ...file,
      id: 'preview',
      mode: 'markdown-preview' as const,
      markdownPreviewSourceFileId: source.id
    }
    store.setState({ openFiles: [source, preview], editorDrafts: { source: 'preview exact' } })
    await render()
    await flush()
    expect(latestVersion()).toBe(stableHashString('preview exact'))
    resetCounts()
    store.getState().clearEditorDraft(source.id)
    await flush()
    expect(latestVersion()).toBe('file:source')
    expect(mocks.hashes.calls).toBe(0)
    store.setState({ openFiles: [source], editorDrafts: { source: 'ordinary source' } })
    await flush()
    resetCounts()
    store.getState().setEditorDraft(source.id, 'ordinary edit')
    await flush()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.hashes.calls).toBe(0)
    store.setState({ openFiles: [{ ...source, language: 'markdown' }] })
    await flush()
    expect(latestVersion()).toBe(stableHashString('ordinary edit'))
  })
})
