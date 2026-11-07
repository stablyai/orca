import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  WORKSPACE_ON_OTHER_RUNTIME
} from '../../../src/shared/protocol-version'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { settleQueryNotifications } from '../test-support/rpc-recording/hook-mount'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { MobileNewTabAgentLoadState } from './mobile-session-route-types'
import { useMobileNewTabAgentOptions } from './use-mobile-new-tab-agent-options'

const claude: RpcResponse = { id: '1', ok: true, result: ['claude'] }

type FakeHost = {
  agents: () => RpcResponse | Promise<RpcResponse>
  settings?: unknown
  connectedAt?: number
}

type FakeClient = RpcClient & { sendRequest: ReturnType<typeof vi.fn> }

function createClient(host: FakeHost): FakeClient {
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'settings.get') {
      return { ok: true, result: { settings: host.settings ?? {} } }
    }
    if (method === 'preflight.detectAgents') {
      return host.agents()
    }
    if (method === 'preflight.refreshAgents') {
      const reply = await host.agents()
      return reply.ok ? { ...reply, result: { agents: reply.result } } : reply
    }
    throw new Error(`unexpected request: ${method}`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double implements the members the hook and loader call.
  return {
    sendRequest,
    subscribe: vi.fn(() => () => {}),
    getState: () => 'connected',
    onStateChange: () => () => {},
    getLastConnectedAt: () => host.connectedAt ?? null
  } as unknown as FakeClient
}

function probes(client: FakeClient): unknown[] {
  return client.sendRequest.mock.calls
    .map(([method]) => method)
    .filter((method) => method !== 'settings.get')
}

type DrawerProps = {
  client: RpcClient
  open: boolean
  prefetch?: boolean
  executionHost?: ExecutionHostId
}

// One page document: every mount shares its query client, as screens in one document do.
function mountDrawer(queryClient: QueryClient) {
  const states: MobileNewTabAgentLoadState[] = []
  let options: MobileNewTabAgentOption[] = []
  function Probe({ client, open, prefetch = false }: DrawerProps) {
    useMobileNewTabAgentOptions({
      client,
      connState: 'connected',
      hostId: 'host-1',
      hostCapabilities: [PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY],
      worktreeId: 'folder:fw-1',
      open,
      prefetch,
      setLoadState: (state) => states.push(state),
      setOptions: (next) => {
        options = next
      }
    })
    return null
  }
  let renderer: ReactTestRenderer | undefined
  return {
    async render(props: DrawerProps): Promise<void> {
      const tree = (
        <QueryClientProvider client={queryClient}>
          <WorkspaceExecutionHostContext.Provider value={props.executionHost}>
            <Probe {...props} />
          </WorkspaceExecutionHostContext.Provider>
        </QueryClientProvider>
      )
      act(() => {
        if (renderer) {
          renderer.update(tree)
        } else {
          renderer = create(tree)
        }
      })
      await settleQueryNotifications()
    },
    state: () => states.at(-1),
    states,
    options: () => options,
    unmount: () => act(() => renderer?.unmount())
  }
}

let queryClient: QueryClient

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  queryClient = createOrcaQueryClient()
})

afterEach(() => {
  queryClient.clear()
  vi.useRealTimers()
})

describe('useMobileNewTabAgentOptions', () => {
  it('#21856: reopening the drawer shows the last agents at once and reads settings again', async () => {
    const host: FakeHost = { agents: () => ({ id: '1', ok: true, result: ['claude', 'codex'] }) }
    const client = createClient(host)
    const drawer = mountDrawer(queryClient)
    await drawer.render({ client, open: true })
    expect(drawer.options()).toEqual([
      { agent: 'claude', label: 'Claude' },
      { agent: 'codex', label: 'Codex' }
    ])

    await drawer.render({ client, open: false })
    host.settings = { disabledTuiAgents: ['codex'] }
    drawer.states.length = 0
    await drawer.render({ client, open: true })

    expect(drawer.states).not.toContain('loading')
    expect(drawer.options()).toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(probes(client)).toEqual(['preflight.detectAgents'])
    drawer.unmount()
  })

  it("does not offer one relayed server's agents for another's workspace with the same id", async () => {
    const drawer = mountDrawer(queryClient)
    const answered = createClient({ agents: () => claude })
    await drawer.render({ client: answered, open: true, executionHost: 'runtime:vm-a' })
    await drawer.render({ client: answered, open: false, executionHost: 'runtime:vm-a' })

    await drawer.render({
      client: createClient({ agents: () => new Promise<RpcResponse>(() => {}) }),
      open: true,
      executionHost: 'runtime:vm-b'
    })

    expect(drawer.state()).toBe('loading')
    expect(drawer.options()).toEqual([])
    drawer.unmount()
  })

  it('refreshes a list an earlier screen loaded once per connection, and shows a refusal over it', async () => {
    const host: FakeHost = { agents: () => claude, connectedAt: 1 }
    const client = createClient(host)
    for (let screen = 0; screen < 3; screen++) {
      vi.advanceTimersByTime(1_000)
      const earlier = mountDrawer(queryClient)
      await earlier.render({ client, open: true })
      earlier.unmount()
    }
    expect(probes(client)).toEqual(['preflight.detectAgents', 'preflight.refreshAgents'])

    host.connectedAt = 2
    host.agents = () => ({
      id: '1',
      ok: false,
      error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME },
      _meta: { runtimeId: 'r' }
    })
    vi.advanceTimersByTime(1_000)
    const drawer = mountDrawer(queryClient)
    await drawer.render({ client, open: true })

    expect(probes(client)).toEqual([
      'preflight.detectAgents',
      'preflight.refreshAgents',
      'preflight.refreshAgents'
    ])
    expect(drawer.states).toEqual(['loaded', 'other-runtime'])
    expect(drawer.options()).toEqual([])
    drawer.unmount()
  })
})
