import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  localDesktopSession,
  relaySshSession
} from '../../../../shared/workspace-layout/persistence/workspace-layout-profile.test-fixture'
import {
  FOLDER_KEY,
  GIT_KEY,
  SSH_KEY
} from '../../../../shared/workspace-layout/persistence/workspace-layout-session.test-fixture'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import '../../orca-runtime-tests/workspace-layout-stream-events.test-fixture'

const SSH_HOST: ExecutionHostId = 'ssh:target-1'

function fakeStore(partitions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const listeners = new Set<(hostId: ExecutionHostId | null) => void>()
  const onWorkspaceSessionWritten = vi.fn((listener: (hostId: ExecutionHostId | null) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  const getWorkspaceSession = vi.fn((hostId: ExecutionHostId) => partitions.get(hostId)!)
  return {
    store: {
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => [...partitions.keys()],
      onWorkspaceSessionWritten
    },
    listeners,
    write(hostId: ExecutionHostId, session: WorkspaceSessionState) {
      partitions.set(hostId, session)
      listeners.forEach((listener) => listener(hostId))
    },
    writeUnnamed(hostId: ExecutionHostId, session: WorkspaceSessionState) {
      partitions.set(hostId, session)
      listeners.forEach((listener) => listener(null))
    },
    removePartition(hostId: ExecutionHostId) {
      partitions.delete(hostId)
      listeners.forEach((listener) => listener(hostId))
    }
  }
}

function setup() {
  const partitions = new Map<ExecutionHostId, WorkspaceSessionState>([
    [LOCAL_EXECUTION_HOST_ID, localDesktopSession()],
    [SSH_HOST, relaySshSession('target-1')]
  ])
  const fake = fakeStore(partitions)
  const homes: Record<string, ExecutionHostId> = {
    [GIT_KEY]: LOCAL_EXECUTION_HOST_ID,
    [FOLDER_KEY]: LOCAL_EXECUTION_HOST_ID,
    [SSH_KEY]: SSH_HOST
  }
  const liveTitles = new Map<string, string>()
  const liveTitle = vi.fn((ptyId: string) => liveTitles.get(ptyId) ?? null)
  const stream = new WorkspaceLayoutStream({
    store: () => fake.store,
    homeHostId: (key) => homes[key] ?? null,
    liveTitle
  })
  return { ...fake, stream, homes, partitions, liveTitles, liveTitle }
}

describe('WorkspaceLayoutStream', () => {
  it('snapshots each workspace from its owning partition only', () => {
    const { stream, homes } = setup()
    const { snapshot } = stream.subscribe(() => {})
    const hostOf = (entry: (typeof snapshot)[number]) => entry.layout.tabs[0]?.executionHostId
    expect(snapshot.map((entry) => [entry.key, hostOf(entry)])).toEqual([
      [GIT_KEY, LOCAL_EXECUTION_HOST_ID],
      [FOLDER_KEY, LOCAL_EXECUTION_HOST_ID],
      [SSH_KEY, SSH_HOST]
    ])
    // A non-owning partition's stray copy must not publish.
    homes[SSH_KEY] = LOCAL_EXECUTION_HOST_ID
    const strayless = new WorkspaceLayoutStream({
      store: () => setup().store,
      homeHostId: (key) => homes[key] ?? null,
      liveTitle: () => null
    }).subscribe(() => {}).snapshot
    expect(strayless.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
  })
})
