import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TerminalInputSource } from '../runtime/terminal-input-source'
import type { TerminalInputSourceResolver } from './server/terminal-input-source-route'

const PANE_KEY = makePaneKey('tab-input', '11111111-1111-4111-8111-111111111111')
const OTHER_PANE_KEY = makePaneKey('tab-other', '22222222-2222-4222-8222-222222222222')
const SOURCE: TerminalInputSource = {
  pairedDeviceId: 'device-laptop',
  deviceName: 'book-laptop',
  clientKind: 'runtime',
  at: 1_700_000_000_000
}

function routeFor(paneKey: string): string {
  return `/pane/${encodeURIComponent(paneKey)}/last-input`
}

/** Resolver a host would wire: one pane with input, one pane without, everything else unknown. */
const resolver: TerminalInputSourceResolver = (paneKey) => {
  if (paneKey === PANE_KEY) {
    return { pane: 'known', source: SOURCE }
  }
  if (paneKey === OTHER_PANE_KEY) {
    return { pane: 'known', source: null }
  }
  return { pane: 'unknown' }
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

  /** Sends a request line Node's parser accepts but the WHATWG URL parser rejects. */
  function rawStatus(
    port: string,
    requestTarget: string,
    token: string,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1')
      let response = ''
      socket.on('connect', () => {
        socket.write(
          `${method} ${requestTarget} HTTP/1.1\r\nHost: x\r\nX-Orca-Agent-Hook-Token: ${token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
        )
      })
      socket.on('data', (chunk) => {
        response += chunk.toString()
      })
      socket.on('end', () => resolve(response.split('\r\n')[0] ?? ''))
      socket.on('error', reject)
    })
  }

  it('returns the source the host resolved for the pane', async () => {
    const { server, port, token } = await startServer()
    server.setTerminalInputSourceResolver(resolver)

    const response = await get(port, routeFor(PANE_KEY), token)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(SOURCE)
  })

  it('answers 204 for a pane the host owns that has seen no input yet', async () => {
    const { server, port, token } = await startServer()
    server.setTerminalInputSourceResolver(resolver)

    const response = await get(port, routeFor(OTHER_PANE_KEY), token)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  })

  it('refuses a missing or wrong token before consulting the resolver', async () => {
    const { server, port } = await startServer()
    let consulted = false
    server.setTerminalInputSourceResolver(() => {
      consulted = true
      return { pane: 'known', source: SOURCE }
    })

    expect((await get(port, routeFor(PANE_KEY))).status).toBe(403)
    expect((await get(port, routeFor(PANE_KEY), 'not-the-token')).status).toBe(403)
    expect(consulted).toBe(false)
  })

  it('answers 404 for no resolver, an unknown pane, or a pane key that does not parse', async () => {
    const { server, port, token } = await startServer()

    expect((await get(port, routeFor(PANE_KEY), token)).status).toBe(404)

    const asked: string[] = []
    server.setTerminalInputSourceResolver((paneKey) => {
      asked.push(paneKey)
      return resolver(paneKey)
    })
    expect((await get(port, routeFor('tab-3:not-a-uuid'), token)).status).toBe(404)
    expect((await get(port, routeFor('x'.repeat(300)), token)).status).toBe(404)
    expect(asked).toEqual([])
    expect(
      (
        await get(
          port,
          routeFor(makePaneKey('tab-x', '33333333-3333-4333-8333-333333333333')),
          token
        )
      ).status
    ).toBe(404)
  })

  it('leaves every other GET as the unauthenticated 404 it always was', async () => {
    const { server, port, token } = await startServer()
    server.setTerminalInputSourceResolver(resolver)

    expect((await get(port, '/hook/claude')).status).toBe(404)
    expect((await get(port, '/hook/claude', token)).status).toBe(404)
    expect((await get(port, '/')).status).toBe(404)
    expect((await get(port, '/pane/a/b/last-input', token)).status).toBe(404)
  })

  it('survives a request target the URL parser rejects', async () => {
    const { server, port, token } = await startServer()
    server.setTerminalInputSourceResolver(resolver)

    expect(await rawStatus(port, 'http://[/pane/x/last-input', token)).toContain('404')
    expect(await rawStatus(port, 'http://[/hook/claude', token, 'POST')).toContain('404')
    // Why: the listener must still be alive and answering after the bad requests.
    expect((await get(port, routeFor(PANE_KEY), token)).status).toBe(200)
  })

  it('answers 500 when the host resolver throws and keeps serving afterwards', async () => {
    const { server, port, token } = await startServer()
    let calls = 0
    server.setTerminalInputSourceResolver((paneKey) => {
      calls += 1
      if (calls === 1) {
        throw new Error('resolver exploded')
      }
      return resolver(paneKey)
    })

    expect((await get(port, routeFor(PANE_KEY), token)).status).toBe(500)
    expect((await get(port, routeFor(PANE_KEY), token)).status).toBe(200)
  })

  it('drops the resolver on stop so a restarted listener cannot answer from a dead runtime', async () => {
    const { server, port, token } = await startServer()
    server.setTerminalInputSourceResolver(resolver)
    expect((await get(port, routeFor(PANE_KEY), token)).status).toBe(200)

    server.stop()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()

    expect(
      (await get(env.ORCA_AGENT_HOOK_PORT, routeFor(PANE_KEY), env.ORCA_AGENT_HOOK_TOKEN)).status
    ).toBe(404)
  })
})
