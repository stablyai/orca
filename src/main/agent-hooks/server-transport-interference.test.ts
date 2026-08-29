// Reproduces #11217's mechanism without an IDS: an authenticated hook POST whose body is cut
// short of its own Content-Length. The listener fails open on every request error, so the only
// way this stays diagnosable is if the truncation is classified before it is swallowed.
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HookTransportInterferenceReport } from '../../shared/agent-hook-transport-interference'
import { AgentHookServer } from './server'

async function postTruncatedHook(
  port: number,
  token: string,
  options: { pathname?: string; sentBytes?: string; announcedLength?: number } = {}
): Promise<void> {
  const {
    pathname = '/hook/claude',
    sentBytes = 'paneKey=tab',
    announcedLength = 100_000
  } = options
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => {
      socket.write(
        `POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nX-Orca-Agent-Hook-Token: ${token}\r\nContent-Length: ${announcedLength}\r\n\r\n${sentBytes}`
      )
      // Why: an RST mid-body is what an inspecting IDS does; a FIN would be an ordinary client hangup.
      setTimeout(() => {
        socket.resetAndDestroy()
        resolve()
      }, 20)
    })
    socket.on('error', () => {
      resolve()
    })
    socket.setTimeout(2_000, () => {
      socket.destroy()
      reject(new Error('truncated post never connected'))
    })
  })
  // Why: the server settles the request on 'close', which lands a tick after the client's reset.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Opens a POST that announces a body and then never sends it, so Orca's own slowloris cap ends it. */
async function postStalledHook(port: number, token: string): Promise<void> {
  const socket = connect({ port, host: '127.0.0.1' })
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
  socket.write(
    `POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nX-Orca-Agent-Hook-Token: ${token}\r\nContent-Length: 100000\r\n\r\n`
  )
  await new Promise<void>((resolve) => {
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
}

async function postCompleteHook(port: number, token: string): Promise<void> {
  const body = 'paneKey=tab%3Aleaf&payload=%7B%7D'
  const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Orca-Agent-Hook-Token': token
    },
    body
  })
  expect(response.status).toBe(204)
}

describe('AgentHookServer transport interference', () => {
  const servers: AgentHookServer[] = []
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    warn.mockClear()
  })

  async function startServer(): Promise<{
    server: AgentHookServer
    port: number
    token: string
    reports: HookTransportInterferenceReport[]
  }> {
    const server = new AgentHookServer()
    servers.push(server)
    const reports: HookTransportInterferenceReport[] = []
    server.setTransportInterferenceListener((report) => {
      reports.push(report)
    })
    await server.start()
    const env = server.buildPtyEnv()
    return {
      server,
      port: Number(env.ORCA_AGENT_HOOK_PORT),
      token: env.ORCA_AGENT_HOOK_TOKEN,
      reports
    }
  }

  it('reports once after repeated truncated POSTs and names the route', async () => {
    const { port, token, reports } = await startServer()

    await postTruncatedHook(port, token)
    await postTruncatedHook(port, token)
    expect(reports).toEqual([])

    await postTruncatedHook(port, token, { pathname: '/hook/codex' })
    expect(reports).toEqual([
      { count: 3, source: 'codex', bytesRead: expect.any(Number), contentLength: 100_000 }
    ])
    expect(warn.mock.calls.flat().join(' ')).toContain('security software')

    // Why: warn-once — a blocked fleet must not turn every hook event into a log line.
    await postTruncatedHook(port, token)
    expect(reports).toHaveLength(1)
  }, 20_000)

  it('never reports for POSTs that deliver their whole body', async () => {
    const { port, token, reports } = await startServer()

    for (let i = 0; i < 5; i++) {
      await postCompleteHook(port, token)
    }

    expect(reports).toEqual([])
  }, 20_000)

  it('excludes requests the slowloris cap destroyed, so the count stays honest', async () => {
    const { port, token, reports } = await startServer()

    await postTruncatedHook(port, token)
    await postTruncatedHook(port, token)
    // Why: Orca destroys this one itself at HOOK_REQUEST_SLOWLORIS_MS; counting it would make
    // every stalled agent look like an IDS block.
    await postStalledHook(port, token)
    expect(reports).toEqual([])

    await postTruncatedHook(port, token)
    expect(reports).toHaveLength(1)
    expect(reports[0].count).toBe(3)
  }, 30_000)

  it('never reports for unauthenticated probes', async () => {
    const { port, reports } = await startServer()

    // Why: a port scanner is not interference; only a request that cleared the token check can be.
    await postTruncatedHook(port, 'wrong-token')
    await postTruncatedHook(port, 'wrong-token')
    await postTruncatedHook(port, 'wrong-token')

    expect(reports).toEqual([])
  }, 20_000)
})
