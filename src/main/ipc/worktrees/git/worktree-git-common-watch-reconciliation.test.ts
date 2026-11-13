import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeViaWatcherProcess } from '../../filesystem/watcher-process/parcel-watcher-process'
import type { WatcherProcessCallback } from '../../filesystem/watcher-process/parcel-watcher-process-subscription'
import { startGitCommonPolling } from './worktree-git-common-polling'

import { createGitCommonWatchReconciliation } from './worktree-git-common-watch-reconciliation'
import type {
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from '../creation/worktree-base-directory-poller'

vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({ isDirectory: () => true })) }))
vi.mock('../../filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))
vi.mock('./worktree-git-common-polling', () => ({ startGitCommonPolling: vi.fn() }))

const commonDirPath = resolve('repository', '.git')
const visibility: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}
const pollMock = vi.mocked(startGitCommonPolling)
const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
const baselines: {
  settle: () => void
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
  onVisible: ReturnType<typeof vi.fn<() => void>>
}[] = []
const starts: Promise<WorktreeBaseSubscription>[] = []
const subscriptions: { callback: WatcherProcessCallback }[] = []
const reconciliations: ReturnType<typeof createGitCommonWatchReconciliation>[] = []

beforeEach(() => {
  pollMock.mockReset()
  subscribeMock.mockReset()
  pollMock.mockImplementation((_path, _onEvents, _interval, pollVisibility) => {
    const { promise, resolve } = Promise.withResolvers<WorktreeBaseSubscription>()
    const onVisible = vi.fn<() => void>()
    let removeVisibilityListener = (): void => {}
    let ready = false
    const unsubscribe = vi.fn(async () => removeVisibilityListener())
    baselines.push({
      settle: () => {
        if (!ready) {
          ready = true
          removeVisibilityListener = pollVisibility.onWindowBecameVisible(onVisible)
          resolve({ unsubscribe })
        }
      },
      unsubscribe,
      onVisible
    })
    return promise
  })
  subscribeMock.mockImplementation(async (_path, callback) => {
    subscriptions.push({ callback })
    return { unsubscribe: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }
  })
})

afterEach(async () => {
  for (const baseline of baselines) {
    baseline.settle()
  }
  for (const starting of starts) {
    await (await starting).unsubscribe()
  }
  for (const reconciliation of reconciliations) {
    await reconciliation.unsubscribe()
  }
  baselines.length = 0
  starts.length = 0
  subscriptions.length = 0
  reconciliations.length = 0
  vi.useRealTimers()
})

function createReconciliation(shouldKeep = () => true) {
  const reconciliation = createGitCommonWatchReconciliation({
    commonDirPath,
    pollIntervalMs: 10,
    visibility,
    canStart: () => true,
    shouldKeep,
    onRootReplacement: vi.fn(),
    onEvents: vi.fn()
  })
  reconciliations.push(reconciliation)
  return reconciliation
}

describe('Git common watcher reconciliation ownership', () => {
  it.each([true, false])(
    'waits for and releases a late baseline when shouldKeep returns %s',
    async (keep) => {
      const reconciliation = createReconciliation(() => keep)
      const starting = reconciliation.ensureStarted()
      const stopping = reconciliation.unsubscribe()
      const stopped = vi.fn()
      void stopping.then(stopped)
      await Promise.resolve()
      await Promise.resolve()
      expect(stopped).not.toHaveBeenCalled()
      baselines[0]?.settle()
      await Promise.all([starting, stopping])
      expect(stopped).toHaveBeenCalledOnce()
      expect(baselines[0]?.unsubscribe).toHaveBeenCalledOnce()
      reconciliation.notifyWindowBecameVisible()
      expect(baselines[0]?.onVisible).not.toHaveBeenCalled()
    }
  )
})
