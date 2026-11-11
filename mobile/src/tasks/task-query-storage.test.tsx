import { createElement, type Dispatch, type SetStateAction } from 'react'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaQueryStoreBackend } from '../device-store/query-storage'
import { hostQueryKey } from '../query/host-query-key'
import { createHostQueryPersistence } from '../query/host-query-persistence'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import { readKeptTaskHydration } from './task-queries'
import { useTaskListCache } from './use-task-list-cache'
import {
  firstPaintTaskKeys,
  NO_TASK_INPUT,
  TASKS_TARGET,
  taskHydrationStorage,
  taskLastListKey,
  taskLastListStorage,
  taskListKey,
  taskListStorage
} from './task-query-storage'

vi.mock('react-native', () => ({ AppState: {} }))
notifyManager.setScheduler(queueMicrotask)

const HOST = 'host-a'
const SAVED_AT = 1_794_000_000_000
const params = { provider: 'linear', workspace: 'ws-1', teams: 'team-1', filter: 'assigned' }
const storedRow = {
  key: 'linear:STA-12',
  provider: 'linear',
  title: 'Keep task lists between launches',
  subtitle: 'STA-12',
  status: 'In Progress',
  updatedAt: '2026-11-07T10:00:00.000Z',
  source: { id: 'issue-12', identifier: 'STA-12', title: 'Keep task lists between launches' }
}

function memoryStore(hostId: string) {
  const rows = new Map<string, string>()
  const backend: OrcaQueryStoreBackend = {
    hostId,
    read: async (keys) => ({
      status: 'ok',
      values: keys.map((storeKey) => rows.get(storeKey) ?? null)
    }),
    write: async (ops) => {
      for (const op of ops) {
        if (op.value === null) {
          rows.delete(op.key)
        } else {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
  return { backend, rows }
}

// What one document leaves on disk for the next: each value as its read landed, then flushed.
async function storeFromEarlierLaunch(
  store: ReturnType<typeof memoryStore>,
  records: { queryKey: readonly unknown[]; persist: unknown; data: unknown }[]
) {
  const earlier = new QueryClient()
  const persistence = createHostQueryPersistence(earlier, store.backend)
  for (const { queryKey, persist, data } of records) {
    earlier.getQueryCache().build(earlier, { queryKey, meta: { persist } })
    earlier.setQueryData(queryKey, data, { updatedAt: SAVED_AT })
  }
  await vi.runAllTimersAsync()
  await persistence.flush()
}

async function relaunch(store: ReturnType<typeof memoryStore>) {
  const relaunched = new QueryClient()
  const persistence = createHostQueryPersistence(relaunched, store.backend)
  const restoring = persistence.restore(firstPaintTaskKeys(HOST))
  await vi.runAllTimersAsync()
  await restoring
  return relaunched
}

describe('Tasks lists kept on the phone', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: SAVED_AT + 60_000 })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('draws the list a provider showed at the last launch before Tasks is ready, rows only', async () => {
    const store = memoryStore(HOST)
    await storeFromEarlierLaunch(store, [
      {
        queryKey: taskLastListKey(HOST, 'linear'),
        persist: taskLastListStorage.persist,
        data: params
      },
      {
        queryKey: taskListKey(HOST, params),
        persist: taskListStorage.persist,
        data: { items: [storedRow] }
      }
    ])
    const relaunched = await relaunch(store)

    const setItems = vi.fn<Dispatch<SetStateAction<TaskItem[]>>>()
    const setError = vi.fn()
    const shown: { rowsReadAt?: number | null } = {}
    function Probe() {
      shown.rowsReadAt = useTaskListCache({
        hostId: HOST,
        items: [],
        jiraConnection: {
          connected: false,
          sites: [],
          selection: null,
          credentialError: null,
          unavailableReason: null
        },
        provider: 'linear',
        taskUiReady: false,
        setItems,
        setError,
        setGithubPages: vi.fn(),
        setGithubCurrentPage: vi.fn(),
        setGithubRepoSources: vi.fn(),
        setGithubSourceErrors: vi.fn(),
        setGithubSourceFallbacks: vi.fn(),
        setGithubCountedTotalPages: vi.fn(),
        setLoading: vi.fn(),
        setTaskListSettled: vi.fn()
      }).rowsReadAt
      return null
    }
    await act(async () => {
      create(createElement(QueryClientProvider, { client: relaunched }, createElement(Probe)))
      await vi.runAllTimersAsync()
    })

    expect(setItems).toHaveBeenCalledWith([storedRow])
    expect(shown.rowsReadAt).toBe(SAVED_AT)
    // A failed first read's error stays up over the stored rows.
    expect(setError).not.toHaveBeenCalled()
  })

  it('shows the spinner for a new search instead of the previous search rows', async () => {
    const issue: TaskItem = {
      key: 'github:repo-1:21204',
      provider: 'github',
      title: '[Feature]: Expose browser tabs',
      subtitle: 'orca #21204',
      status: 'open',
      updatedAt: '2026-11-10T06:51:00.000Z',
      source: {
        id: 'issue-21204',
        type: 'issue',
        number: 21204,
        title: '[Feature]: Expose browser tabs',
        state: 'open',
        url: 'https://github.com/stablyai/orca/issues/21204',
        labels: [],
        updatedAt: '2026-11-10T06:51:00.000Z',
        author: 'octocat',
        repoId: 'repo-1'
      }
    }
    const openIssues = { provider: 'github', kind: 'issues', query: 'is:issue is:open', repos: '' }
    const bugSearch = { ...openIssues, query: 'is:issue is:open [Bug]' }
    const setLoading = vi.fn()
    const cache: { current?: ReturnType<typeof useTaskListCache> } = {}
    function Probe() {
      cache.current = useTaskListCache({
        hostId: HOST,
        items: [issue],
        jiraConnection: {
          connected: false,
          sites: [],
          selection: null,
          credentialError: null,
          unavailableReason: null
        },
        provider: 'github',
        taskUiReady: true,
        setItems: vi.fn(),
        setError: vi.fn(),
        setGithubPages: vi.fn(),
        setGithubCurrentPage: vi.fn(),
        setGithubRepoSources: vi.fn(),
        setGithubSourceErrors: vi.fn(),
        setGithubSourceFallbacks: vi.fn(),
        setGithubCountedTotalPages: vi.fn(),
        setLoading,
        setTaskListSettled: vi.fn()
      })
      return null
    }
    await act(async () => {
      create(
        createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe))
      )
      await vi.runAllTimersAsync()
    })
    act(() => cache.current!.shown('github', openIssues))

    act(() => cache.current!.begin(bugSearch, 'github'))
    expect(setLoading).toHaveBeenCalledWith(true)
    expect(cache.current!.revalidating).toBe(false)

    act(() => cache.current!.shown('github', bugSearch))
    setLoading.mockClear()
    act(() => cache.current!.begin(bugSearch, 'github'))
    expect(setLoading).not.toHaveBeenCalled()
    expect(cache.current!.revalidating).toBe(true)
  })

  it('keeps agent launch commands and hook trust out of the stored hydration', async () => {
    const store = memoryStore(HOST)
    await storeFromEarlierLaunch(store, [
      {
        queryKey: hostQueryKey(HOST, taskHydrationStorage.family, TASKS_TARGET, NO_TASK_INPUT),
        persist: taskHydrationStorage.persist,
        data: {
          settings: {
            visibleTaskProviders: ['github', 'linear'],
            agentCmdOverrides: { claude: 'ANTHROPIC_API_KEY=sk-ant-secret claude' }
          },
          ui: {
            taskResumeState: { linearPreset: 'assigned' },
            trustedOrcaHooks: { 'repo-1': { setup: 'hash-trusted' } }
          },
          glabInstalled: false,
          linearConnected: true
        }
      }
    ])
    const kept = readKeptTaskHydration(await relaunch(store), HOST)
    expect(kept.stored).toBe(true)
    expect(kept.hydration).toEqual({
      settings: { visibleTaskProviders: ['github', 'linear'] },
      ui: { taskResumeState: { linearPreset: 'assigned' } },
      glabInstalled: false,
      linearConnected: true
    })
  })
})
