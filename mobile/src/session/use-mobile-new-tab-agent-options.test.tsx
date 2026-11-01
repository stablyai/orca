import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY,
  WORKSPACE_ON_OTHER_RUNTIME
} from '../../../src/shared/protocol-version'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { useMobileNewTabAgentOptions } from './use-mobile-new-tab-agent-options'

const claude: RpcResponse = { id: '1', ok: true, result: ['claude'] }
const codex: RpcResponse = { id: '1', ok: true, result: ['codex'] }

type FakeHost = {
  agents: () => RpcResponse | Promise<RpcResponse>
  settings?: unknown
}

function createClient(host: FakeHost): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test double implements the two members the loader calls.
  return { sendRequest, subscribe: vi.fn(() => () => {}) } as unknown as RpcClient & {
    sendRequest: ReturnType<typeof vi.fn>
  }
}

function probes(client: { sendRequest: ReturnType<typeof vi.fn> }): unknown[] {
  return client.sendRequest.mock.calls
    .map(([method]) => method)
    .filter((method) => method !== 'settings.get')
}

function mountDrawer(hostId: string) {
  const setLoadState = vi.fn()
  const setOptions = vi.fn()
  function Probe({ client, open }: { client: RpcClient; open: boolean }) {
    useMobileNewTabAgentOptions({
      client,
      connState: 'connected',
      hostId,
      hostCapabilities: [PREFLIGHT_OTHER_RUNTIME_REFUSAL_RUNTIME_CAPABILITY],
      worktreeId: 'folder:fw-1',
      open,
      setLoadState,
      setOptions
    })
    return null
  }
  let renderer: ReactTestRenderer | undefined
  const render = async (
    client: RpcClient,
    open: boolean,
    executionHost?: ExecutionHostId
  ): Promise<void> => {
    const tree = (
      <WorkspaceExecutionHostContext.Provider value={executionHost}>
        <Probe client={client} open={open} />
      </WorkspaceExecutionHostContext.Provider>
    )
    await act(async () => {
      if (renderer) {
        renderer.update(tree)
      } else {
        renderer = create(tree)
      }
    })
  }
  const states = (): unknown[] => setLoadState.mock.calls.map(([state]) => state)
  const reset = (): void => {
    setLoadState.mockClear()
    setOptions.mockClear()
  }
  return { render, states, reset, setOptions, unmount: () => renderer?.unmount() }
}

describe('useMobileNewTabAgentOptions', () => {
  it('#21856: reopening the drawer shows the last agents at once and does not detect again', async () => {
    const drawer = mountDrawer('host-reopen')
    const host: FakeHost = { agents: () => ({ id: '1', ok: true, result: ['claude', 'codex'] }) }
    const client = createClient(host)
    await drawer.render(client, true)
    expect(drawer.states()).toEqual(['loading', 'loaded'])

    await drawer.render(client, false)
    host.settings = { disabledTuiAgents: ['codex'] }
    drawer.reset()
    await drawer.render(client, true)

    expect(drawer.states()).toEqual(['loaded', 'loaded'])
    expect(drawer.setOptions.mock.calls[0]?.[0]).toEqual([
      { agent: 'claude', label: 'Claude' },
      { agent: 'codex', label: 'Codex' }
    ])
    expect(drawer.setOptions.mock.lastCall?.[0]).toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(probes(client)).toEqual(['preflight.detectAgents'])
    drawer.unmount()
  })

  it("does not offer one relayed server's agents for another's workspace with the same id", async () => {
    const drawer = mountDrawer('host-relay')
    const answered = createClient({ agents: () => claude })
    await drawer.render(answered, true, 'runtime:vm-a')
    await drawer.render(answered, false, 'runtime:vm-a')
    drawer.reset()

    await drawer.render(
      createClient({ agents: () => new Promise<RpcResponse>(() => {}) }),
      true,
      'runtime:vm-b'
    )

    expect(drawer.states()).toEqual(['loading'])
    expect(drawer.setOptions.mock.calls).toEqual([[[]]])
    drawer.unmount()
  })

  it("refreshes the host's agents on a new screen, and shows a refusal over the cached ones", async () => {
    const first = mountDrawer('host-refusal')
    const host: FakeHost = { agents: () => claude }
    const client = createClient(host)
    await first.render(client, true)
    first.unmount()
    host.agents = () => ({
      id: '1',
      ok: false,
      error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME },
      _meta: { runtimeId: 'r' }
    })

    const drawer = mountDrawer('host-refusal')
    await drawer.render(client, true)

    expect(probes(client)).toEqual(['preflight.detectAgents', 'preflight.refreshAgents'])
    expect(drawer.states()).toEqual(['loaded', 'other-runtime'])
    expect(drawer.setOptions.mock.lastCall?.[0]).toEqual([])
    host.agents = () => codex
    await drawer.render(client, false)
    drawer.reset()
    await drawer.render(client, true)
    expect(drawer.states()[0]).toBe('loading')
    drawer.unmount()
  })
})
