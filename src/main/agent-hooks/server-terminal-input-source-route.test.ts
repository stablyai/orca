import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  buildTerminalInputSourcePath,
  type TerminalInputSource
} from '../../shared/terminal-input-source'

const PANE_KEY = makePaneKey('tab-input', '11111111-1111-4111-8111-111111111111')
const SOURCE: TerminalInputSource = {
  pairedDeviceId: 'device-laptop',
  deviceName: 'book-laptop',
  clientKind: 'runtime',
  at: 1_700_000_000_000
}

describe('AgentHookServer GET /pane/<paneKey>/last-input', () => {
  const servers: AgentHookServer[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
  })

  async function startServer(): Promise<{ server: AgentHookServer; port: string; token: string }> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    return { server, port: env.ORCA_AGENT_HOOK_PORT, token: env.ORCA_AGENT_HOOK_TOKEN }
  }

  function get(port: string, path: string, token?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'GET',
      headers: token ? { 'X-Orca-Agent-Hook-Token': token } : {}
    })
  }

  it('returns the source the host resolved for the pane', async () => {
    const { server, port, token } = await startServer()
    const asked: string[] = []
    server.setTerminalInputSourceResolver((paneKey) => {
      asked.push(paneKey)
      return paneKey === PANE_KEY ? SOURCE : null
    })

    const response = await get(port, buildTerminalInputSourcePath(PANE_KEY), token)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(SOURCE)
    expect(asked).toEqual([PANE_KEY])
  })

  it('refuses a request without the hook token before consulting the resolver', async () => {
    const { server, port } = await startServer()
    let consulted = false
    server.setTerminalInputSourceResolver(() => {
      consulted = true
      return SOURCE
    })

    const response = await get(port, buildTerminalInputSourcePath(PANE_KEY))

    expect(response.status).toBe(403)
    expect(consulted).toBe(false)
  })

  it('answers 404 when no resolver is wired, the pane is unknown, or the path is not the route', async () => {
    const { server, port, token } = await startServer()

    expect((await get(port, buildTerminalInputSourcePath(PANE_KEY), token)).status).toBe(404)

    server.setTerminalInputSourceResolver(() => null)
    expect((await get(port, buildTerminalInputSourcePath(PANE_KEY), token)).status).toBe(404)
    expect((await get(port, '/hook/claude', token)).status).toBe(404)
  })
})
