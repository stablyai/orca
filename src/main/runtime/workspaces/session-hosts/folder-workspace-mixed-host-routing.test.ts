import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  MIXED_GROUP,
  MIXED_FOLDER,
  ROUTING_REPOS
} from '../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { localDesktopSession } from '../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { WorkspaceLayoutStream } from '../../terminal/surface/workspace-layout-stream'
import { collectLayoutEvents } from '../../orca-runtime-tests/workspace-layout-stream-events.test-fixture'
import {
  partialRuntimeStore,
  storeRepo
} from '../../orca-runtime-tests/runtime-store-partial-fixture'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

function runtimeWithMixedFolder() {
  const repos = ROUTING_REPOS.map(storeRepo)
  const partitions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', localDesktopSession()],
    ['ssh:target-1', emptySession()]
  ])
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjectGroups: () => [MIXED_GROUP],
    getFolderWorkspaces: () => [MIXED_FOLDER],
    getFolderWorkspace: (id: string) => (id === MIXED_FOLDER.id ? MIXED_FOLDER : undefined),
    getWorkspaceSessionHostIds: () => [...partitions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) => partitions.get(hostId) ?? emptySession(),
    onWorkspaceSessionWritten: () => () => {}
  }
  return { runtime: new OrcaRuntimeService(partialRuntimeStore(store)) }
}

afterEach(() => {
  mocks.layoutOwnerIsMain = true
  vi.restoreAllMocks()
})

describe('a folder whose project group mixes local and SSH repos (layout-owner build)', () => {
  it('keeps the layout stream flowing and publishes the folder from the local partition', () => {
    const { runtime } = runtimeWithMixedFolder()
    const { snapshot } = runtime.subscribeWorkspaceLayouts(() => {})
    expect(snapshot.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
  })
})

describe('a workspace the router throws on', () => {
  function streamThrowingOn(key: string) {
    const session = localDesktopSession()
    const writeListeners = new Set<(hostId: ExecutionHostId | null) => void>()
    const store = {
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: (): ExecutionHostId[] => ['local', 'ssh:target-1'],
      onWorkspaceSessionWritten: (listener: (hostId: ExecutionHostId | null) => void) => {
        writeListeners.add(listener)
        return () => writeListeners.delete(listener)
      }
    }
    const route = { throws: true }
    const stream = new WorkspaceLayoutStream({
      store: () => store,
      homeHostId: (candidate) => {
        if (route.throws && candidate === key) {
          throw new Error('route failed')
        }
        return 'local'
      },
      liveTitle: () => null
    })
    const write = () => writeListeners.forEach((listener) => listener(null))
    return { stream, route, write }
  }
  const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

  it('is left out, and every other workspace is still published, logged once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { stream } = streamThrowingOn(FOLDER_KEY)
    expect(stream.subscribe(() => {}).snapshot.map((entry) => entry.key)).toEqual([GIT_KEY])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('keeps its last published layout instead of sending a removal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { stream, route, write } = streamThrowingOn(FOLDER_KEY)
    route.throws = false
    const collector = collectLayoutEvents()
    const first = stream.subscribe(collector.listener)
    collector.seed(first.snapshot)
    const events = collector.events
    expect(first.snapshot.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
    route.throws = true
    write()
    await flush()
    expect(events).toEqual([])
    const later = stream.subscribe(() => {}).snapshot
    expect(later.find((entry) => entry.key === FOLDER_KEY)?.layout).toEqual(
      first.snapshot.find((entry) => entry.key === FOLDER_KEY)?.layout
    )
  })

  it('still fails the whole projection in a window-owned build', () => {
    mocks.layoutOwnerIsMain = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(streamThrowingOn(FOLDER_KEY).stream.subscribe(() => {}).snapshot).toEqual([])
  })
})
