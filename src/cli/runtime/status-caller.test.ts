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
describe.skipIf(process.platform === 'win32')(
  "orca status reports a session caller's Orca session ID",
  () => {
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

    it('asks the host as the session its environment names, and prints the Orca session ID it resolved', async () => {
      process.env.ORCA_AGENT_SESSION_ID = SESSION
      process.env.ORCA_TERMINAL_HANDLE = 'term_tui'
      const caller = { orcaSessionId: `orca_session_id:${SESSION}`, live: true }
      callerShowReply = { result: { caller } }

      expect(await statusCaller()).toEqual(caller)
      const [request] = callerShowRequests()
      // Nothing names the caller in params: the host reads the envelope, as every verb's entry does.
      expect(request?.params).toBeUndefined()
      expect(request?.orchestrationCompatibilityEvidence).toMatchObject({
        agentSessionId: SESSION,
        terminalHandle: 'term_tui'
      })
      expect(await status(false)).toContain(`\norcaSessionId: orca_session_id:${SESSION}`)
    })

    it.each([
      ['a terminal agent', { ORCA_TERMINAL_HANDLE: 'term_mine', ORCA_PANE_KEY: 'tab_1:leaf_1' }],
      ['a pane key alone', { ORCA_PANE_KEY: 'tab_1:leaf_1' }],
      ['a plain shell', {}]
    ])('prints exactly the readiness status for %s, without asking the host', async (_who, env) => {
      Object.assign(process.env, env)

      const printed: { result: Record<string, unknown> } = JSON.parse(await status(true))
      const text = await status(false)

      expect(printed.result).not.toHaveProperty('caller')
      // The status text ends where main's does, with nothing about the caller.
      expect(text.split('\n').at(-1)).toMatch(/^graphState: /)
      expect(text).not.toMatch(/^(?:orcaSessionId|caller):/m)
      expect(callerShowRequests()).toHaveLength(0)
    })

    it("reports the host's refusal of the session instead of an Orca session ID", async () => {
      process.env.ORCA_AGENT_SESSION_ID = SESSION
      callerShowReply = {
        error: { code: 'session_caller_not_live', message: `Agent session ${SESSION} has ended.` }
      }

      expect(await statusCaller()).toEqual({
        live: false,
        refusal: { code: 'session_caller_not_live', message: `Agent session ${SESSION} has ended.` }
      })
      expect(await status(false)).toContain(
        '\norcaSessionId: none (refused: session_caller_not_live)'
      )
    })

    it('leaves the caller out when the host predates the method', async () => {
      process.env.ORCA_AGENT_SESSION_ID = SESSION
      callerShowReply = { error: { code: 'method_not_found', message: 'Unknown method' } }

      expect(JSON.parse(await status(true)).result).not.toHaveProperty('caller')
    })
  }
)
