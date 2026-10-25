import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type { LegacyWorkerRecoveryResolution } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeStore } from './runtime-store-contract'

function makeResolution(index: number): LegacyWorkerRecoveryResolution {
  return {
    resolution: index % 2 === 0 ? 'adopted' : 'exited',
    candidate: {
      dispatchId: `dispatch-${index}`,
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: `task-${index}`,
      worktreeId: index % 2 === 0 ? `repo::/workspace-${index}` : `folder:workspace-${index}`,
      terminalHandle: `handle-${index}`,
      paneKey: `tab-${index}:leaf-${index}`,
      tabId: `tab-${index}`,
      leafId: `leaf-${index}`,
      processIncarnation: `pty-${index}:inc-${index}`,
      ptyId: `pty-${index}`,
      incarnationId: `inc-${index}`
    }
  }
}

function makeFixture(hosts: readonly ExecutionHostId[], count: number) {
  const resolutions = Array.from({ length: count }, (_, index) => makeResolution(index))
  const sessions = new Map<string, WorkspaceSessionState>()
  const owners = new Map<string, ExecutionHostId>()
  for (const [index, { candidate }] of resolutions.entries()) {
    const host = hosts[index % hosts.length]!
    owners.set(candidate.worktreeId, host)
    const session = sessions.get(host) ?? {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {}
    }
    session.tabsByWorktree[candidate.worktreeId] = [
      {
        id: candidate.tabId,
        ptyId: candidate.ptyId,
        worktreeId: candidate.worktreeId,
        title: 'Worker',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    session.sleepingAgentSessionsByPaneKey![candidate.paneKey] = {
      paneKey: candidate.paneKey,
      worktreeId: candidate.worktreeId,
      agent: 'claude',
      providerSession: { key: 'session_id', id: `session-${index}` },
      prompt: '',
      state: 'waiting',
      capturedAt: 1,
      updatedAt: 1
    }
    sessions.set(host, session)
  }
  const getWorkspaceSession = (hostId?: string | null) => {
    const session = sessions.get(hostId ?? 'local')
    if (!session) {
      throw new Error('Unexpected host')
    }
    return session
  }
  const setWorkspaceSession = vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
    sessions.set(hostId ?? 'local', session)
  })
  const flushPendingOrThrowAsync = vi.fn(async () => {})
  const unused = () => {
    throw new Error('Unexpected persistence dependency')
  }
  const store: RuntimeStore = withDurableRuntimeStore({
    getRepos: unused,
    getRepo: unused,
    addRepo: unused,
    updateRepo: unused,
    getAllWorktreeMeta: unused,
    getWorktreeMeta: unused,
    setWorktreeMeta: unused,
    removeWorktreeMeta: unused,
    getGitHubCache: unused,
    getSettings: unused,
    getWorkspaceSession,
    setWorkspaceSession,
    flushPendingOrThrowAsync
  })
  const persistence = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
    () => store,
    unused,
    (worktreeId) => owners.get(worktreeId) ?? null
  )
  return {
    persistence,
    resolutions,
    getWorkspaceSession,
    setWorkspaceSession,
    flushPendingOrThrowAsync
  }
}

afterEach(() => vi.restoreAllMocks())

describe('legacy worker recovery persistence snapshot budget', () => {
  it.each([1, 10, 100])('takes two host snapshots for %i recovered workers', async (count) => {
    const fixture = makeFixture(['local'], count)
    const clone = vi.spyOn(globalThis, 'structuredClone')

    const result = await fixture.persistence.persist(fixture.resolutions)

    expect(result).toEqual(
      new Set(fixture.resolutions.map(({ candidate }) => candidate.dispatchId))
    )
    expect(clone).toHaveBeenCalledTimes(2)
    expect(fixture.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
    expect(fixture.getWorkspaceSession().sleepingAgentSessionsByPaneKey).toEqual({})
    for (const { candidate, resolution } of fixture.resolutions) {
      expect(fixture.getWorkspaceSession().tabsByWorktree[candidate.worktreeId]).toHaveLength(
        resolution === 'exited' ? 0 : 1
      )
    }
  })

  it('bounds snapshots by host for an interleaved local, SSH and runtime batch', async () => {
    const hosts = ['local', 'ssh:remote', 'runtime:peer'] as const
    const fixture = makeFixture(hosts, 12)
    const clone = vi.spyOn(globalThis, 'structuredClone')

    expect((await fixture.persistence.persist(fixture.resolutions)).size).toBe(12)

    expect(clone).toHaveBeenCalledTimes(hosts.length * 2)
    for (const host of hosts) {
      expect(fixture.getWorkspaceSession(host).sleepingAgentSessionsByPaneKey).toEqual({})
    }
    expect(fixture.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
  })

  it('rolls back every host without overwriting edits made during the durable write', async () => {
    const hosts = ['local', 'ssh:remote', 'runtime:peer'] as const
    const fixture = makeFixture(hosts, 12)
    const originals = new Map(
      hosts.map((host) => [host, structuredClone(fixture.getWorkspaceSession(host))])
    )
    const pendingWrite = Promise.withResolvers<void>()
    const writeStarted = Promise.withResolvers<void>()
    fixture.flushPendingOrThrowAsync.mockImplementationOnce(() => {
      writeStarted.resolve()
      return pendingWrite.promise
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = fixture.persistence.persist(fixture.resolutions)
    await writeStarted.promise
    for (const host of hosts) {
      const current = fixture.getWorkspaceSession(host)
      expect(current.sleepingAgentSessionsByPaneKey).toEqual({})
      // In-place edits must not mutate the final snapshot used by rollback.
      current.activeWorktreeId = `new-selection-${host}`
      current.tabsByWorktree[`new-folder-${host}`] = []
    }
    pendingWrite.reject(new Error('Disk write failed'))

    expect(await result).toEqual(new Set())
    for (const host of hosts) {
      const original = originals.get(host)!
      expect(fixture.getWorkspaceSession(host)).toEqual({
        ...original,
        activeWorktreeId: `new-selection-${host}`,
        tabsByWorktree: { ...original.tabsByWorktree, [`new-folder-${host}`]: [] }
      })
    }
  })

  it('still flushes previously adopted surfaces when this batch makes no session edits', async () => {
    const fixture = makeFixture(['local'], 10)
    fixture.getWorkspaceSession().sleepingAgentSessionsByPaneKey = {}
    for (const resolution of fixture.resolutions) {
      resolution.resolution = 'adopted'
    }

    expect((await fixture.persistence.persist(fixture.resolutions)).size).toBe(10)

    expect(fixture.setWorkspaceSession).not.toHaveBeenCalled()
    expect(fixture.flushPendingOrThrowAsync).toHaveBeenCalledTimes(1)
  })

  it('does not snapshot or flush an empty or unroutable batch', async () => {
    const fixture = makeFixture(['local'], 1)
    const clone = vi.spyOn(globalThis, 'structuredClone')

    expect(await fixture.persistence.persist([])).toEqual(new Set())
    expect(await fixture.persistence.persist([makeResolution(100)])).toEqual(new Set())

    expect(clone).not.toHaveBeenCalled()
    expect(fixture.flushPendingOrThrowAsync).not.toHaveBeenCalled()
  })

  it('uses the provider that proved absence when a deleted folder has no host lookup', async () => {
    const fixture = makeFixture(['ssh:remote'], 1)
    const resolution = makeResolution(100)
    resolution.resolution = 'exited'
    resolution.hostId = 'ssh:remote'

    expect(await fixture.persistence.persist([resolution])).toEqual(new Set(['dispatch-100']))
    expect(fixture.setWorkspaceSession.mock.calls[0][1]).toBe('ssh:remote')
    expect(fixture.flushPendingOrThrowAsync).toHaveBeenCalledOnce()
  })

  it('prefers owning-provider evidence over stale workspace host metadata', async () => {
    const fixture = makeFixture(['local', 'ssh:remote'], 2)
    const localBefore = structuredClone(fixture.getWorkspaceSession('local'))
    const resolution = fixture.resolutions[0]
    resolution.resolution = 'exited'
    resolution.hostId = 'ssh:remote'

    expect(await fixture.persistence.persist([resolution])).toEqual(new Set(['dispatch-0']))
    expect(fixture.setWorkspaceSession.mock.calls[0][1]).toBe('ssh:remote')
    expect(fixture.getWorkspaceSession('local')).toEqual(localBefore)
  })
})
