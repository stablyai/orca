import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient
} from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import type { PhoneMcpServer } from './mcp-server-operations'
import { useMcpServerActions } from './use-mcp-server-actions'

type Actions = ReturnType<typeof useMcpServerActions>

const server: PhoneMcpServer = {
  id: 'server-example-1',
  name: 'example',
  detail: 'https://mcp.example.test/mcp',
  transport: 'http',
  remote: false,
  agentsOff: [],
  workspaces: { later: true, on: [], off: [] },
  sharedProcess: false
}

// Remove deletes saved values and sign-ins for good: only the confirm's own button may send it.
describe('useMcpServerActions remove', () => {
  let renderer: ReactTestRenderer | null = null
  let actions: Actions | null = null

  function Harness({ client }: { client: FakeRpcClient }) {
    actions = useMcpServerActions({
      client,
      list: null,
      applyServer: () => {},
      showToast: () => {},
      t: (key) => key
    })
    return null
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    actions = null
  })

  it('asks first with what goes, sends nothing on cancel, and removes once on confirm', async () => {
    const client = createFakeRpcClient()
    act(() => {
      renderer = create(createElement(Harness, { client }))
    })

    act(() => actions?.remove(server, () => {}))
    expect(actions?.confirm?.message).toBe('mcpServers.removeMessageSavedData')
    act(() => actions?.closeConfirm())
    expect(actions?.confirm).toBeNull()
    expect(client.requests).toHaveLength(0)

    act(() => actions?.remove(server, () => {}))
    await act(async () => actions?.confirm?.onConfirm())
    expect(client.requests.map((request) => [request.method, request.args[1]])).toEqual([
      ['mcpServers.remove', { id: server.id }]
    ])
  })
})
