import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import type { SendRequestOptions } from '../../transport/rpc/unvalidated-rpc-request-port'
import '../../../../src/shared/protocol-version'
import { PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY } from '../../../../src/shared/preflight-runtime-capabilities'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../../navigation/workspace-execution-host'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import { settleQueryNotifications } from '../../test-support/rpc-recording/hook-mount'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { MobileNewTabAgentLoadState } from './mobile-agent-load-state'
import { useMobileNewTabAgentOptions } from './use-mobile-new-tab-agent-options'

const claude: RpcResponse = { id: '1', ok: true, result: ['claude'] }

type FakeHost = {
  agents: () => RpcResponse | Promise<RpcResponse>
  repos?: () => RpcResponse
  settings?: unknown
  connectedAt?: number
}

type FakeClient = RpcClient & { sendRequest: ReturnType<typeof vi.fn> }

function createClient(host: FakeHost): FakeClient {
  const sendRequest = vi.fn(
    async (method: string, _params?: unknown, options?: SendRequestOptions) => {
      options?.beforeSend?.()
      if (method === 'settings.get') {
        return { ok: true, result: { settings: host.settings ?? {} } }
      }
      if (method === 'repo.list' && host.repos) {
        return host.repos()
      }
      if (method === 'preflight.detectAgents') {
        return host.agents()
      }
      if (method === 'preflight.refreshAgents') {
        const reply = await host.agents()
        return reply.ok ? { ...reply, result: { agents: reply.result } } : reply
      }
      throw new Error(`unexpected request: ${method}`)
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double implements the members the hook and loader call.
  return {
    sendRequest,
    subscribe: vi.fn(() => () => {}),
    getState: () => 'connected',
    onStateChange: () => () => {},
    getLastConnectedAt: () => host.connectedAt ?? null
  } as unknown as FakeClient
}

type DrawerProps = {
  client: RpcClient
  open: boolean
  prefetch?: boolean
  executionHost?: ExecutionHostId
  worktreeId?: string
}

// One page document: every mount shares its query client, as screens in one document do.
function mountDrawer(queryClient: QueryClient) {
  const states: MobileNewTabAgentLoadState[] = []
  let options: MobileNewTabAgentOption[] = []
  function Probe({ client, open, prefetch = false, worktreeId = 'folder:fw-1' }: DrawerProps) {
    const sheet = useMobileNewTabAgentOptions({
      client,
      connState: 'connected',
      hostId: 'host-1',
      hostCapabilities: [PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY],
      worktreeId,
      open,
      prefetch
    })
    if (states.at(-1) !== sheet.loadState) {
      states.push(sheet.loadState)
    }
    options = sheet.options
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
  it('keeps a stale-sheet automatic refresh distinct from an explicit user refresh', async () => {
    const client = createClient({ agents: () => claude })
    const first = mountDrawer(queryClient)
    await first.render({ client, open: true })
    first.unmount()
    vi.setSystemTime(1_000_001)
    const reopened = mountDrawer(queryClient)
    await reopened.render({ client, open: true })
    expect(
      client.sendRequest.mock.calls
        .filter(([method]) => method === 'preflight.refreshAgents')
        .map(([, params]) => params)
    ).toEqual([expect.not.objectContaining({ userInitiated: true })])
    reopened.unmount()
  })
})
