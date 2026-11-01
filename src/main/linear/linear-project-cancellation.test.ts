import { setImmediate } from 'node:timers/promises'
import { beforeEach, expect, it, vi } from 'vitest'
import { getProject, listProjects, listProjectsByExactName } from './linear-project-queries'
import { listProjectTeams } from './linear-project-team-queries'
import { acquire, release } from './linear-request-concurrency'

const { provider } = vi.hoisted(() => ({ provider: vi.fn() }))
vi.mock('./client', () => ({
  getClients: (_workspaceId: string, signal?: AbortSignal) => [
    {
      workspace: { id: 'workspace-1', organizationName: 'Workspace' },
      client: { client: { rawRequest: () => provider(signal) } }
    }
  ],
  isAuthError: () => false
}))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))

const project = { id: 'project-1', name: 'Project' }
const teams = [{ id: 'team-1', name: 'Team', key: 'TM' }]
const connection = { nodes: [project], pageInfo: { hasNextPage: false } }
const response = {
  data: {
    project: { ...project, teams: { nodes: teams, pageInfo: { hasNextPage: false } } },
    projects: connection,
    searchProjects: connection
  }
}
const readers = [
  {
    name: 'collection',
    read: (force = false, signal?: AbortSignal) =>
      listProjects(undefined, 20, 'workspace-1', force, signal),
    expected: { items: [project] }
  },
  {
    name: 'exact name',
    read: (force = false, signal?: AbortSignal) =>
      listProjectsByExactName('Project', 'workspace-1', force, signal),
    expected: [project]
  },
  {
    name: 'detail',
    read: (force = false, signal?: AbortSignal) =>
      getProject('project-1', 'workspace-1', force, signal),
    expected: project
  },
  {
    name: 'teams',
    read: (force = false, signal?: AbortSignal) =>
      listProjectTeams('project-1', 'workspace-1', force, signal),
    expected: teams
  }
]

beforeEach(() => vi.clearAllMocks())

it.each(readers)(
  '$name keeps cancellation request-owned and preserves shared refreshes',
  async ({ read, expected }) => {
    for (const signalledFirst of [true, false]) {
      const pending: { signal?: AbortSignal; finish: () => void }[] = []
      const observedAbort = vi.fn()
      provider.mockImplementation(
        (signal?: AbortSignal) =>
          new Promise((resolve, reject) => {
            const onAbort = () => {
              observedAbort()
              reject(signal?.reason)
            }
            signal?.addEventListener('abort', onAbort, { once: true })
            pending.push({
              signal,
              finish: () => {
                signal?.removeEventListener('abort', onAbort)
                resolve(response)
              }
            })
          })
      )
      const caller = new AbortController()
      const cancelled = new Error('write caller disconnected')
      const first = read(signalledFirst, signalledFirst ? caller.signal : undefined)
      const second = read(false, signalledFirst ? undefined : caller.signal)
      const shared = read()
      const signalled = signalledFirst ? first : second
      const independent = signalledFirst ? second : first
      const outcome = signalled.catch((error: unknown) => error)
      const settled = Promise.allSettled([first, second, shared])
      try {
        await setImmediate()
        expect(pending).toHaveLength(2)
        expect(pending.filter((request) => request.signal === caller.signal)).toHaveLength(1)
        caller.abort(cancelled)
        await expect(outcome).resolves.toBe(cancelled)
        expect(observedAbort).toHaveBeenCalledTimes(1)

        // A forced shared refresh replaces the shared read, never the request-owned read.
        const refreshed = read(true)
        const joinedRefresh = read()
        const refreshedSettled = Promise.allSettled([refreshed, joinedRefresh])
        try {
          await setImmediate()
          expect(pending).toHaveLength(3)
          pending[2].finish()
          await expect(refreshed).resolves.toMatchObject(expected)
          await expect(joinedRefresh).resolves.toMatchObject(expected)
          for (const request of pending) {
            request.finish()
          }
          await expect(independent).resolves.toMatchObject(expected)
          await expect(shared).resolves.toMatchObject(expected)
        } finally {
          for (const request of pending) {
            request.finish()
          }
          await refreshedSettled
        }
      } finally {
        caller.abort(cancelled)
        for (const request of pending) {
          request.finish()
        }
        await settled
      }

      // All four real queue permits remain available after both owners settle.
      await Promise.all([acquire(), acquire(), acquire(), acquire()])
      for (let i = 0; i < 4; i++) {
        release()
      }
    }
  }
)
