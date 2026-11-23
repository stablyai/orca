import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { TaskListLoadingModel } from '../../task-list/use-mobile-tasks-task-list-loading'
import { DISCONNECTED_CLICKUP_CONNECTION } from './clickup-mobile-connection'
import { DEFAULT_CLICKUP_FILTER } from './mobile-clickup-filters'
import { fetchClickUpTaskPage } from './mobile-clickup-task-source'
import { useMobileTasksClickUpPagination } from './use-mobile-tasks-clickup-pagination'

vi.mock('./mobile-clickup-task-source', () => ({ fetchClickUpTaskPage: vi.fn() }))

let renderer: ReactTestRenderer | null = null
let loadMore: (() => Promise<void>) | null = null

function mount(overrides: { refreshing: boolean }) {
  const client: RpcClient = {
    sendRequest: vi.fn(),
    subscribe: vi.fn(),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: vi.fn(),
    getReconnectAttempt: vi.fn(),
    getLastConnectedAt: vi.fn(),
    onStateChange: vi.fn(),
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  const fields = {
    appliedQuery: '',
    client,
    clientRef: { current: client },
    clickupConnection: DISCONNECTED_CLICKUP_CONNECTION,
    clickupFilter: DEFAULT_CLICKUP_FILTER,
    clickupLoadingMore: false,
    clickupNextPage: 1,
    hostId: 'host',
    loadGenerationRef: { current: 1 },
    loading: false,
    provider: 'clickup',
    revalidating: false,
    setClickUpLoadingMore: vi.fn(),
    setClickUpNextPage: vi.fn(),
    setError: vi.fn(),
    setItems: vi.fn(),
    tasksSupported: true,
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields above; the full model is the whole Tasks screen state.
  const model = fields as unknown as TaskListLoadingModel
  function Harness() {
    loadMore = useMobileTasksClickUpPagination(model)
    return null
  }
  act(() => {
    renderer = create(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Harness))
    )
  })
  return fields
}

beforeEach(() => {
  vi.mocked(fetchClickUpTaskPage).mockReset()
  vi.mocked(fetchClickUpTaskPage).mockResolvedValue({ tasks: [], nextPage: null })
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  loadMore = null
})

it('does not read another page while a silent refresh is replacing the first one', async () => {
  const fields = mount({ refreshing: true })

  await act(async () => loadMore!())

  expect(fetchClickUpTaskPage).not.toHaveBeenCalled()
  expect(fields.setClickUpLoadingMore).not.toHaveBeenCalled()
})

it('reads the next page when nothing else is loading the list', async () => {
  mount({ refreshing: false })

  await act(async () => loadMore!())

  expect(fetchClickUpTaskPage).toHaveBeenCalledOnce()
})
