/* Canonicalized events must map back to the subscribed alias, or desktop/runtime/relay consumers drop them as outside the worktree. */
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from '../../watcher-aliased-root-fixture'
import {
  acknowledgeWatcherSubscribe,
  currentWatcherChild,
  FakeWatcherChild
} from './parcel-watcher-process-test-child'

const { forkMock, existsSyncMock, mkdtempSyncMock, parcelSubscribeMock, rmSyncMock } = vi.hoisted(
  () => ({
    forkMock: vi.fn(),
    existsSyncMock: vi.fn(),
    mkdtempSyncMock: vi.fn(() => '/tmp/orca-watcher-canary-rewrite-test'),
    parcelSubscribeMock: vi.fn(),
    rmSyncMock: vi.fn()
  })
)

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', async (importOriginal) => {
  // Preserve native realpath while mocking child launch.
  const actual = await importOriginal<typeof NodeFs>()
  return {
    existsSync: existsSyncMock,
    mkdtempSync: mkdtempSyncMock,
    rmSync: rmSyncMock,
    realpathSync: actual.realpathSync
  }
})
vi.mock('@parcel/watcher', () => ({ subscribe: parcelSubscribeMock }))

import {
  disposeWatcherProcess,
  resetRuntimeWatcherProcessForTest,
  resetWatcherProcessForTest,
  subscribeViaRuntimeWatcherProcess,
  subscribeViaWatcherProcess
} from './parcel-watcher-process'
import type { WatcherProcessEvent } from './parcel-watcher-process-protocol'

describe('watcher-process root path rewrite', () => {
  let root: AliasedWatcherRoot | null = null

  beforeEach(() => {
    resetWatcherProcessForTest()
    resetRuntimeWatcherProcessForTest()
    // Hide the Vitest marker to exercise forked mode instead of the in-process fallback.
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeWatcherChild())
  })

  afterEach(async () => {
    disposeWatcherProcess()
    resetRuntimeWatcherProcessForTest()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    await removeAliasedWatcherRoot(root)
    root = null
  })

  async function subscribeAndEmit(
    subscribe: typeof subscribeViaWatcherProcess,
    aliasRoot: string,
    events: WatcherProcessEvent[]
  ): Promise<WatcherProcessEvent[][]> {
    const delivered: WatcherProcessEvent[][] = []
    const pending = subscribe(aliasRoot, (_error, batch) => delivered.push(batch), {})
    const child = currentWatcherChild(forkMock)
    const id = acknowledgeWatcherSubscribe(child)
    await pending
    child.emit('message', { op: 'events', id, events })
    return delivered
  }

  it('rewrites resolved-alias paths for desktop watches', async () => {
    root = await createAliasedWatcherRoot('watcher-rewrite-')
    const delivered = await subscribeAndEmit(subscribeViaWatcherProcess, root.aliasRoot, [
      { type: 'update', path: join(root.realRoot, 'src', 'agent-edit.ts'), isDirectory: false }
    ])

    expect(delivered).toEqual([
      [
        {
          type: 'update',
          path: join(root.aliasRoot, 'src', 'agent-edit.ts'),
          isDirectory: false
        }
      ]
    ])
  })

  // The runtime pool is also what a relay host uses for every SSH worktree watch.
  it('rewrites resolved-alias paths for runtime and relay watches', async () => {
    root = await createAliasedWatcherRoot('watcher-rewrite-')
    const delivered = await subscribeAndEmit(subscribeViaRuntimeWatcherProcess, root.aliasRoot, [
      { type: 'create', path: join(root.realRoot, 'docs', 'notes.md') }
    ])

    expect(delivered).toEqual([
      [{ type: 'create', path: join(root.aliasRoot, 'docs', 'notes.md') }]
    ])
  })

  it('leaves an unaliased root untouched', async () => {
    root = await createAliasedWatcherRoot('watcher-rewrite-')
    const eventPath = join(root.realRoot, 'src', 'agent-edit.ts')
    const delivered = await subscribeAndEmit(subscribeViaWatcherProcess, root.realRoot, [
      { type: 'update', path: eventPath, isDirectory: false }
    ])

    expect(delivered).toEqual([[{ type: 'update', path: eventPath, isDirectory: false }]])
  })
})
