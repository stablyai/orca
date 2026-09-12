import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { DeviceRegistry } from './device-registry'
import { defineMethod } from './rpc/core'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, sleep, waitFor } from './runtime-rpc-test-harness'

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

describe('mission.plan long-poll transport', () => {
  it('keeps the Unix socket alive until delayed plan generation returns', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mission-plan-keepalive-'))
    const planner = defineMethod({
      name: 'mission.plan',
      params: z.object({ text: z.string() }),
      // Why: scaled-down generation delay; keepalives must protect longer real planner runs too.
      handler: async () => {
        await sleep(180)
        return { mission: 'planned after generation' }
      }
    })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      keepaliveIntervalMs: 30,
      methods: [planner]
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_mission_plan',
        authToken: metadata!.authToken,
        method: 'mission.plan',
        params: { text: 'Plan a repair.' }
      })
      await session.done

      const keepalives = session.frames.filter((frame) => frame._keepalive === true)
      const terminal = session.frames.filter((frame) => frame.ok !== undefined)
      expect(terminal).toEqual([
        expect.objectContaining({
          id: 'req_mission_plan',
          ok: true,
          result: { mission: 'planned after generation' }
        })
      ])
      expect(keepalives.length).toBeGreaterThanOrEqual(3)
    } finally {
      await server.stop()
    }
  })

  it('applies the same long-poll classification at the WebSocket boundary', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mission-plan-websocket-'))
    const planner = defineMethod({
      name: 'mission.plan',
      params: z.object({}),
      handler: async (_params, { signal }) =>
        await new Promise<{ mission: string }>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => resolve({ mission: 'cancelled generation' }),
            { once: true }
          )
        })
    })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: false,
      longPollCap: 1,
      methods: [planner]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    const socket = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []

    try {
      const first = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_mission_plan',
          method: 'mission.plan',
          deviceToken: device.token,
          params: {}
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )
      await waitFor(() => server['activeLongPolls'] === 1)

      await server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_mission_plan_busy',
          method: 'mission.plan',
          deviceToken: device.token,
          params: {}
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'req_mission_plan_busy',
          ok: false,
          error: expect.objectContaining({ code: 'runtime_busy' })
        })
      )

      socket.readyState = 3
      socket.emit('close')
      await first
      expect(server['activeLongPolls']).toBe(0)
    } finally {
      await server.stop()
    }
  })
})
