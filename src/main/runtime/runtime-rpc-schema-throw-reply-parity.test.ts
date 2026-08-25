import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import type { OrcaRuntimeService } from './orca-runtime'

// STA-4818: a param schema that throws must still produce exactly one structured
// reply on every transport, not a silent hang plus an unhandled rejection.
const THROWING_PARAM_METHODS = ['computer.pressKey', 'computer.hotkey'] as const

// Only an *absent* `key` reaches the refinement as undefined: when the property is present but
// invalid, `requiredString`'s transform still puts '' in the parsed object. The present-but-invalid
// rows guard that boundary, so a change to `requiredString` that starts dropping the key is caught.
const KEY_PAYLOADS = [
  { label: 'no params', params: {} },
  { label: 'an absent key', params: { app: 'Finder' } },
  { label: 'an empty key', params: { app: 'Finder', key: '' } },
  { label: 'a non-string key', params: { app: 'Finder', key: 42 } }
] as const

const userDataPaths: string[] = []

function makeServer(): { server: OrcaRuntimeRpcServer; deviceToken: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rpc-schema-throw-'))
  userDataPaths.push(userDataPath)
  const runtime = { getRuntimeId: () => 'test-runtime' } as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  // Why: computer.* is off the mobile allowlist; runtime-scope pairings reach it.
  const device = server['deviceRegistry']!.addDevice('desktop', 'runtime')
  return { server, deviceToken: device.token }
}

describe('RPC reply contract when a param schema throws', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }

  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    while (userDataPaths.length > 0) {
      rmSync(userDataPaths.pop()!, { recursive: true, force: true })
    }
  })

  for (const method of THROWING_PARAM_METHODS) {
    for (const { label, params } of KEY_PAYLOADS) {
      it(`replies once with invalid_argument over WebSocket for ${method} with ${label}`, async () => {
        const { server, deviceToken } = makeServer()
        const replies: string[] = []

        // Why: production fires this with `void` and never awaits it, so a rejection here is an
        // unhandled rejection and the caller waits for its own timeout. Reproduce that exactly.
        void server['handleWebSocketMessage'](
          JSON.stringify({ id: 'ws-1', method, deviceToken, params }),
          (response) => replies.push(response),
          () => {}
        )
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(unhandled).toEqual([])
        expect(replies).toHaveLength(1)
        expect(JSON.parse(replies[0])).toMatchObject({
          id: 'ws-1',
          ok: false,
          error: { code: 'invalid_argument' }
        })
      })

      it(`matches the unix-socket reply for ${method} with ${label}`, async () => {
        const { server, deviceToken } = makeServer()
        const wsReplies: string[] = []
        await server['handleWebSocketMessage'](
          JSON.stringify({ id: 'req-1', method, deviceToken, params }),
          (response) => wsReplies.push(response),
          () => {}
        )

        // Why: main answered this one `internal_error` via the socket transport's `.catch`,
        // so parity is the assertion that matters, not just "some error came back".
        const socketResponse = await server['handleMessage'](
          JSON.stringify({ id: 'req-1', method, authToken: server['authToken'], params })
        )

        expect(socketResponse).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
        expect(socketResponse).toEqual(JSON.parse(wsReplies[0]))
      })
    }
  }
  // Why: the WebSocket handler is fired with `void`, so anything throwing BEFORE the dispatcher's
  // own try — not just a param schema — would strand the caller with zero frames. STA-4818 removed
  // one such trigger; this pins the transport guarantee that outlives any single trigger.
  // Limit worth knowing: the error frame is built from the runtime's id, so a runtime service that
  // is itself broken cannot be answered. Every step on this path reads an already-resolved field.
  it('still replies once when dispatch throws before its own try block', async () => {
    const { server, deviceToken } = makeServer()
    Object.defineProperty(server, 'dispatcher', {
      value: {
        dispatchStreaming: () => {
          throw new Error('pre-dispatch failure')
        }
      }
    })
    const replies: string[] = []

    void server['handleWebSocketMessage'](
      JSON.stringify({ id: 'ws-1', method: 'status.get', deviceToken, params: {} }),
      (response) => replies.push(response),
      () => {}
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unhandled).toEqual([])
    expect(replies).toHaveLength(1)
    expect(JSON.parse(replies[0])).toMatchObject({
      id: 'ws-1',
      ok: false,
      error: { code: 'internal_error', message: 'pre-dispatch failure' }
    })
  })
  // Why: admitLongPoll reserves a capacity slot and registerWebSocketDispatchAbort registers a
  // controller, both BEFORE the try whose finally releases them. A throw in that window used to
  // strand the caller AND leak the slot forever, so repeated failures would eventually make every
  // terminal.wait / orchestration.ask return runtime_busy against a cap that never drains.
  it('releases the long-poll slot when the acquire window throws', async () => {
    const { server, deviceToken } = makeServer()
    const ws = {
      get readyState(): number {
        throw new Error('socket went away')
      },
      on: () => {},
      off: () => {}
    } as unknown as Parameters<(typeof server)['handleWebSocketMessage']>[4]
    const before = server['activeLongPolls']
    const replies: string[] = []

    void server['handleWebSocketMessage'](
      // terminal.wait is a long-poll class, so a slot is reserved before the throw.
      JSON.stringify({ id: 'ws-1', method: 'terminal.wait', deviceToken, params: {} }),
      (response) => replies.push(response),
      () => {},
      undefined,
      ws
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unhandled).toEqual([])
    expect(replies).toHaveLength(1)
    expect(server['activeLongPolls']).toBe(before)
  })
})
