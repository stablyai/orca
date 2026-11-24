import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CLICKUP_RUNTIME_CAPABILITY } from '../../../../src/shared/clickup/clickup-runtime-capability'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  DISCONNECTED_CLICKUP_CONNECTION,
  readClickUpConnection,
  reconcileClickUpReadFailure
} from '../providers/clickup/clickup-mobile-connection'
import { taskRuntimeStatusRead } from '../screen-state/mobile-task-runtime-operations'
import {
  useMobileTasksProviderLoadActions,
  type ProviderLoadActionsInput
} from './use-mobile-tasks-provider-load-actions'

vi.mock('../providers/clickup/clickup-mobile-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/clickup/clickup-mobile-connection')>()),
  readClickUpConnection: vi.fn()
}))
vi.mock('../screen-state/mobile-task-runtime-operations', () => ({
  taskRuntimeStatusRead: { request: vi.fn(), interpret: vi.fn() },
  taskSettingsWrite: { request: vi.fn() }
}))

function fakeClient(): RpcClient {
  return {
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
}

function deferred<T>() {
  let reject!: (reason: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

let renderer: ReactTestRenderer | null = null
let refreshClickUpConnection: (() => Promise<void>) | null = null
const setClickUpConnection = vi.fn()

function mount(client: RpcClient) {
  const model: ProviderLoadActionsInput = {
    appliedQuery: '',
    client,
    clientRef: { current: client },
    connState: 'connected',
    defaultLinearTeamSelectionRef: { current: null },
    githubKind: 'issues',
    keepSettings: vi.fn(),
    linearAccountBindingRef: { current: null },
    setJiraConnection: vi.fn(),
    jiraStatusRequestIdRef: { current: 0 },
    setClickUpConnection,
    clickupStatusRequestIdRef: { current: 0 },
    setLinearConnected: vi.fn(),
    setLinearTeams: vi.fn(),
    setLinearWorkspaces: vi.fn(),
    setSelectedLinearTeamIds: vi.fn(),
    setSelectedLinearWorkspaceId: vi.fn(),
    taskUiReady: true,
    tasksSupported: true
  }
  function Harness() {
    refreshClickUpConnection = useMobileTasksProviderLoadActions(model).refreshClickUpConnection
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
}

beforeEach(() => {
  setClickUpConnection.mockReset()
  vi.mocked(taskRuntimeStatusRead.interpret).mockReturnValue({
    capabilities: [CLICKUP_RUNTIME_CAPABILITY]
  })
  vi.mocked(readClickUpConnection).mockResolvedValue(DISCONNECTED_CLICKUP_CONNECTION)
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  refreshClickUpConnection = null
})

it('reports the failure of the refresh that is still current', async () => {
  vi.mocked(taskRuntimeStatusRead.request).mockRejectedValue(new Error('host unreachable'))
  mount(fakeClient())

  await expect(refreshClickUpConnection!()).rejects.toThrow('host unreachable')

  expect(setClickUpConnection).toHaveBeenCalledExactlyOnceWith(reconcileClickUpReadFailure)
})

it('swallows the failure of a refresh that a newer one superseded', async () => {
  const first = deferred<never>()
  vi.mocked(taskRuntimeStatusRead.request)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ id: 'status', ok: true, result: {} })
  mount(fakeClient())

  const superseded = refreshClickUpConnection!()
  await refreshClickUpConnection!()
  first.reject(new Error('host unreachable'))

  await expect(superseded).resolves.toBeUndefined()
  expect(setClickUpConnection).toHaveBeenCalledTimes(1)
  expect(setClickUpConnection).not.toHaveBeenCalledWith(reconcileClickUpReadFailure)
})
