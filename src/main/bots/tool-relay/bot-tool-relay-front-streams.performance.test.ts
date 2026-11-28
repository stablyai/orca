// Guards #51086: event streams and calls through one front stop at their budgets, so calls and
// cleanup always get one of the daemon's pipes, and a refused connection closes at once.
import { EventEmitter } from 'node:events'
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  FRONT_OPEN_BUDGET,
  FRONT_STREAM_BUDGET,
  KeptRelayGrants
} from './bot-tool-relay-kept-grants'
import { TOOL_RELAY_FRONT_MAX_PIPES } from '../../daemon/tool-relay-front/daemon-tool-relay-front'

type Answer = EventEmitter & { shouldKeepAlive: boolean }

function request(
  kept: KeptRelayGrants,
  method: string,
  socket: Socket
): { admitted: boolean; res: Answer } {
  const res = Object.assign(new EventEmitter(), { shouldKeepAlive: true })
  const admitted = kept.admitThroughFront({ method, socket }, res, () => ({}))
  return { admitted: admitted !== null, res }
}

describe('front stream budget', () => {
  it('admits streams and calls up to their budgets, refuses the rest with a closing answer, and keeps room for cleanup', () => {
    const kept = new KeptRelayGrants(async () => null)
    const connections = Array.from({ length: FRONT_STREAM_BUDGET + 10 }, () => new Socket())
    for (const socket of connections) {
      kept.cameThroughFront(socket, 4000)
    }
    const streams = connections.map((socket) => request(kept, 'GET', socket))
    expect(streams.filter((stream) => stream.admitted)).toHaveLength(FRONT_STREAM_BUDGET)
    const refused = streams.filter((stream) => !stream.admitted)
    expect(refused.every((stream) => !stream.res.shouldKeepAlive)).toBe(true)
    expect(TOOL_RELAY_FRONT_MAX_PIPES - FRONT_STREAM_BUDGET).toBeGreaterThanOrEqual(32)

    // Calls fill up to the open budget; cleanup still gets in past it.
    const throughFront = (method: string) => {
      const socket = new Socket()
      kept.cameThroughFront(socket, 4000)
      return request(kept, method, socket)
    }
    const fronted = Array.from({ length: FRONT_OPEN_BUDGET - FRONT_STREAM_BUDGET + 1 }, () =>
      throughFront('POST')
    )
    expect(fronted.filter((call) => call.admitted)).toHaveLength(
      FRONT_OPEN_BUDGET - FRONT_STREAM_BUDGET
    )
    expect(TOOL_RELAY_FRONT_MAX_PIPES - FRONT_OPEN_BUDGET).toBeGreaterThanOrEqual(8)
    expect(throughFront('DELETE').admitted).toBe(true)
    // Another front's streams aren't counted against this one's.
    const elsewhere = new Socket()
    kept.cameThroughFront(elsewhere, 4001)
    expect(request(kept, 'GET', elsewhere).admitted).toBe(true)

    // A stream ending frees its slot, and a call ending frees room for a call.
    streams[0]!.res.emit('close')
    fronted[0]!.res.emit('close')
    expect(request(kept, 'GET', connections[0]!).admitted).toBe(true)
    expect(request(kept, 'GET', connections[1]!).admitted).toBe(false)
  })
})
