import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { CORE_HANDLERS } from '../handlers/core'
import { RuntimeClient } from './client'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'
const RUNTIME_ID = 'runtime-caller'
const IDENTITY_ENV = ['ORCA_AGENT_SESSION_ID', 'ORCA_TERMINAL_HANDLE', 'ORCA_PANE_KEY'] as const

type ReceivedRequest = RuntimeOrchestrationEnvelope & {
  id: string
  method: string
  params?: unknown
}

type HostReply = { result: unknown } | { error: { code: string; message: string } }

/**
 * The real `orca status` handler and CLI client over a real Unix socket. The host's side of
 * `orchestration.callerShow` is covered against the real dispatcher in orchestration-caller-show.
 */
describe.skipIf(process.platform === 'win32')('orca status reports its caller address', () => {
  let server: Server
  const sockets = new Set<Socket>()
  const received: ReceivedRequest[] = []
  const savedEnv = new Map<string, string | undefined>()
  let userDataPath: string
  let callerShowReply: HostReply

  beforeEach(async () => {
    for (const key of IDENTITY_ENV) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    received.length = 0
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-status-caller-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => answer(socket, String(data).trim()))
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: RUNTIME_ID,
        pid: process.pid,
        transport: { kind: 'unix', endpoint },
        authToken: 'token',
        startedAt: Date.now()
      })
    )
  })

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.restoreAllMocks()
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  function answer(socket: Socket, line: string): void {
    const request: ReceivedRequest = JSON.parse(line)
    received.push(request)
    const reply: HostReply =
      request.method === 'status.get'
        ? {
            result: {
              runtimeId: RUNTIME_ID,
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0
            }
          }
        : callerShowReply
    const ok = 'result' in reply
    socket.write(
      `${JSON.stringify({ id: request.id, ok, ...reply, _meta: { runtimeId: RUNTIME_ID } })}\n`
    )
  }

  async function status(json: boolean): Promise<string> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await CORE_HANDLERS.status({
      client: new RuntimeClient(userDataPath),
      flags: new Map(),
      cwd: userDataPath,
      json
    })
    return String(log.mock.calls.at(-1)?.[0])
  }

  async function statusCaller(): Promise<unknown> {
    const printed: { result: Record<string, unknown> } = JSON.parse(await status(true))
    return printed.result.caller
  }

  function callerShowRequests(): ReceivedRequest[] {
    return received.filter((request) => request.method === 'orchestration.callerShow')
  }

  it('asks the host as the session its environment names, and prints what the host resolved', async () => {
    process.env.ORCA_AGENT_SESSION_ID = SESSION
    process.env.ORCA_TERMINAL_HANDLE = 'term_tui'
    const address = {
      kind: 'session',
      address: `session:${SESSION}`,
      sessionId: SESSION,
      live: true
    }
    callerShowReply = { result: { caller: address } }

    expect(await statusCaller()).toEqual(address)
    const [request] = callerShowRequests()
    // Nothing names the caller in params: the host reads the envelope, as every verb's entry does.
    expect(request?.params).toBeUndefined()
    expect(request?.orchestrationCompatibilityEvidence).toMatchObject({
      agentSessionId: SESSION,
      terminalHandle: 'term_tui'
    })
    expect(await status(false)).toContain(`caller: session:${SESSION}`)
  })

  it('asks the host about the terminal handle a PTY agent carries', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_mine'
    callerShowReply = {
      result: { caller: { kind: 'terminal', address: 'term_mine', live: false } }
    }

    expect(await statusCaller()).toEqual({ kind: 'terminal', address: 'term_mine', live: false })
    expect(callerShowRequests()[0]?.orchestrationCompatibilityEvidence).toEqual({
      terminalHandle: 'term_mine'
    })
    expect(await status(false)).toContain('caller: term_mine (not live)')
  })

  it("reports the host's refusal of the session instead of an address", async () => {
    process.env.ORCA_AGENT_SESSION_ID = SESSION
    callerShowReply = {
      error: { code: 'session_caller_not_live', message: `Agent session ${SESSION} has ended.` }
    }

    expect(await statusCaller()).toEqual({
      kind: 'session',
      sessionId: SESSION,
      live: false,
      refusal: { code: 'session_caller_not_live', message: `Agent session ${SESSION} has ended.` }
    })
  })

  it('leaves the caller out when the host predates the method', async () => {
    process.env.ORCA_AGENT_SESSION_ID = SESSION
    callerShowReply = { error: { code: 'method_not_found', message: 'Unknown method' } }

    expect(JSON.parse(await status(true)).result).not.toHaveProperty('caller')
  })

  it('lets the host decide that a process carries no identity', async () => {
    callerShowReply = { result: { caller: null } }

    expect(await statusCaller()).toBeNull()
    expect(callerShowRequests()).toHaveLength(1)
    expect(await status(false)).toContain('caller: none')
  })

  it('asks the host about a process that carries only a pane key', async () => {
    process.env.ORCA_PANE_KEY = 'tab_1:leaf_1'
    callerShowReply = {
      result: { caller: { kind: 'terminal', address: 'term_reminted', live: true } }
    }

    expect(await statusCaller()).toEqual({ kind: 'terminal', address: 'term_reminted', live: true })
    expect(callerShowRequests()[0]?.orchestrationCompatibilityEvidence).toEqual({
      paneKey: 'tab_1:leaf_1'
    })
  })
})
