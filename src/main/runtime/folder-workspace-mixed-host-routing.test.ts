import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import {
  FOLDER_HOST_CASES,
  MIXED_GROUP,
  MIXED_FOLDER,
  ROUTING_REPOS
} from '../../shared/folder-workspace-host-routing.test-fixture'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LayoutApplyOutcome } from '../../shared/workspace-layout/workspace-layout-command-types'
import { localDesktopSession } from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from './workspace-layout-stream-events.test-fixture'
import { partialRuntimeStore, storeRepo } from './runtime-store-partial-fixture'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

function runtimeWithMixedFolder(
  folder: FolderWorkspace = MIXED_FOLDER,
  groups: readonly ProjectGroup[] = [MIXED_GROUP]
) {
  const repos = ROUTING_REPOS.map(storeRepo)
  const partitions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', localDesktopSession()],
    ['ssh:target-1', emptySession()]
  ])
  const applyLayoutCommand = vi.fn(async (): Promise<LayoutApplyOutcome> => ({
    ok: true,
    result: {}
  }))
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjectGroups: () => [...groups],
    getFolderWorkspaces: () => [folder],
    getWorkspaceSessionHostIds: () => [...partitions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) => partitions.get(hostId) ?? emptySession(),
    onWorkspaceSessionWritten: () => () => {},
    applyLayoutCommand
  }
  return { runtime: new OrcaRuntimeService(partialRuntimeStore(store)), applyLayoutCommand }
}

const RATIOS = {
  type: 'setGroupRatios',
  workspace: FOLDER_KEY,
  groupLayout: { type: 'leaf', groupId: 'group-a' }
} as const

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

  it('applies a layout command for it to the local partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithMixedFolder()
    const reply = await runtime.applyLayoutCommand(RATIOS)
    expect(reply.ok).toBe(true)
    expect(applyLayoutCommand).toHaveBeenCalledWith(RATIOS, ['local'])
  })
})

describe('every folder kind routes where the window saves it (layout-owner build)', () => {
  // The window's side of each case runs in workspace-session-folder-host-twin.test.ts.
  it.each(FOLDER_HOST_CASES)('$name', async ({ folder, groups, expected }) => {
    const { runtime, applyLayoutCommand } = runtimeWithMixedFolder(folder, groups)
    await runtime.applyLayoutCommand(RATIOS)
    expect(applyLayoutCommand).toHaveBeenCalledWith(RATIOS, [expected])
  })
})

describe('the same folder in a window-owned build', () => {
  it('keeps refusing to route it', () => {
    mocks.layoutOwnerIsMain = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = runtimeWithMixedFolder()
    expect(runtime.subscribeWorkspaceLayouts(() => {}).snapshot).toEqual([])
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

  it('a routing warning never hides a later listener failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { stream, route, write } = streamThrowingOn(FOLDER_KEY)
    stream.subscribe(() => {
      throw new Error('listener failed')
    })
    route.throws = false
    write()
    await flush()
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      '[workspace-layout] layout stream routing failed:',
      '[workspace-layout] layout stream listener failed:'
    ])
  })

  it('still fails the whole projection in a window-owned build', () => {
    mocks.layoutOwnerIsMain = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(streamThrowingOn(FOLDER_KEY).stream.subscribe(() => {}).snapshot).toEqual([])
  })
})
