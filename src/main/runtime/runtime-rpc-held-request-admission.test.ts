import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { createLongPollServer } from './runtime-rpc-long-poll-server.test-fixture'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { openFramedSession, sendRequest, waitFor } from './runtime-rpc-test-harness'

// Why: 10-19, ~40 coordinators held check --wait; past 16 every wait and action was refused unread.
const HELD_WAITS = 40

const readyCalls = [
  { method: 'orchestration.check', params: { wait: true } },
  { method: 'orchestration.ask', params: {} },
  { method: 'orchestration.workerStart', params: {} },
  { method: 'agent.launch', params: { prompt: { text: 'continue' } } },
  { method: 'terminal.send', params: { agentPrompt: true } },
  { method: 'status.get', params: {} }
]

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('long-polls take no admission slot', () => {
  it('answers waits, actions and short calls while 40 waits are held on the local socket', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-held-admission-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    const held = deferred()
    const heldIds = new Set<string>()
    vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request) => {
      if (request.method === 'terminal.wait') {
        heldIds.add(request.id)
        await held.promise
      }
      return { id: request.id, ok: true, result: {}, _meta: { runtimeId: runtime.getRuntimeId() } }
    })
    await server.start()
    const sessions: ReturnType<typeof openFramedSession>[] = []
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata?.transports[0]) {
        throw new Error('Missing test transport')
      }
      const endpoint = metadata.transports[0].endpoint
      for (let index = 0; index < HELD_WAITS; index += 1) {
        sessions.push(
          openFramedSession(endpoint, {
            id: `held-${index}`,
            authToken: metadata.authToken,
            method: 'terminal.wait'
          })
        )
      }
      await waitFor(() => heldIds.size === HELD_WAITS, 10_000)

      for (const call of readyCalls) {
        const response = await sendRequest(endpoint, {
          id: call.method,
          authToken: metadata.authToken,
          ...call
        })
        expect(response).toMatchObject({ id: call.method, ok: true })
      }
    } finally {
      held.resolve()
      for (const session of sessions) {
        session.socket.destroy()
      }
      await Promise.all(sessions.map((session) => session.done.catch(() => {})))
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('answers waits and actions while 40 waits are held on a paired connection', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-held-admission-'))
    const server = new OrcaRuntimeRpcServer({ runtime: new OrcaRuntimeService(), userDataPath })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('test-desktop', 'runtime')
    const held = deferred()
    const replies: { id: string; ok: boolean }[] = []
    vi.spyOn(server['dispatcher'], 'dispatchStreaming').mockImplementation(
      async (request, reply) => {
        if (request.method === 'terminal.wait') {
          await held.promise
        }
        reply(JSON.stringify({ id: request.id, ok: true }))
      }
    )
    const dispatch = (id: string, method: string, params?: unknown): Promise<void> =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method, params, deviceToken: device.token }),
        (reply) => replies.push(JSON.parse(reply)),
        () => {}
      )
    const waits: Promise<void>[] = []
    try {
      for (let index = 0; index < HELD_WAITS; index += 1) {
        waits.push(dispatch(`held-${index}`, 'terminal.wait'))
      }
      for (const call of readyCalls) {
        await dispatch(call.method, call.method, call.params)
      }
      expect(replies).toEqual(readyCalls.map((call) => ({ id: call.method, ok: true })))
    } finally {
      held.resolve()
      await Promise.all(waits)
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('returns mail already pending to a check --wait while 40 real mail waits are held', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-held-admission-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    // A consuming check requires a live pane; this test only needs the waits to block.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab_${handle}:leaf`)
    const waitForMessage = vi.spyOn(runtime, 'waitForMessage')
    const server = createLongPollServer({ runtime, userDataPath })
    await server.start()
    const sessions: ReturnType<typeof openFramedSession>[] = []
    try {
      const metadata = readRuntimeMetadata(userDataPath)
      if (!metadata?.transports[0]) {
        throw new Error('Missing test transport')
      }
      const endpoint = metadata.transports[0].endpoint
      for (let index = 0; index < HELD_WAITS; index += 1) {
        sessions.push(
          openFramedSession(endpoint, {
            id: `held-${index}`,
            authToken: metadata.authToken,
            method: 'orchestration.check',
            params: { terminal: `term_held_${index}`, wait: true, timeoutMs: 30_000 }
          })
        )
      }
      await waitFor(() => waitForMessage.mock.calls.length === HELD_WAITS, 10_000)
      db.insertMessage({ from: 'term_worker', to: 'term_coordinator', subject: 'pending question' })

      await expect(
        sendRequest(endpoint, {
          id: 'pending',
          authToken: metadata.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_coordinator', wait: true, timeoutMs: 5_000 }
        })
      ).resolves.toMatchObject({
        id: 'pending',
        ok: true,
        result: { count: 1, messages: [{ subject: 'pending question' }] }
      })
    } finally {
      for (const session of sessions) {
        session.socket.destroy()
      }
      await Promise.all(sessions.map((session) => session.done.catch(() => {})))
      db.close()
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
