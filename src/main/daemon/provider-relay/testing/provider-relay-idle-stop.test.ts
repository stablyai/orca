import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayIdleStop } from '../provider-relay-idle-stop'
import { readProviderRelayDetachPolicy } from '../provider-relay-work-markers'
import { ProviderRelayPendingRequests } from '../provider-relay-pending-requests'
import { ProviderRelayCarriedWork } from '../../../provider-relay/provider-relay-carried-work'
import { CODEX_RELAY_WORK_MARKERS } from '../../../codex/app-server/codex-app-server-relay'

const IDLE_MS = 30 * 60_000
const T = 'thread-1'

function policy(open?: Record<string, string[][]>) {
  const read = readProviderRelayDetachPolicy({
    idleStopMs: IDLE_MS,
    markers: CODEX_RELAY_WORK_MARKERS.markers,
    ...(open ? { open } : {})
  })
  if (!read) {
    throw new Error('policy refused')
  }
  return read
}

const turn = (method: string, threadId = T) => JSON.stringify({ method, params: { threadId } })
const command = (method: string, status: string) =>
  JSON.stringify({
    method,
    params: { threadId: T, item: { type: 'commandExecution', id: 'cmd-1', status } }
  })

function rig() {
  const state = { attached: true, pending: 0, unacked: [] as string[] | null }
  const stop = vi.fn()
  const idle = new ProviderRelayIdleStop({
    attached: () => state.attached,
    live: () => true,
    pendingCount: () => state.pending,
    unacked: () => state.unacked?.map((line, i) => ({ seq: i + 1, line })) ?? null,
    stop
  })
  idle.configure(policy())
  const line = (text: string) => {
    if (state.attached) {
      state.unacked?.push(text)
    }
    idle.observeAgentLine(text)
  }
  const detach = (open?: Record<string, string[][]>) => {
    state.attached = false
    idle.arm(policy(open))
  }
  return { idle, state, stop, line, detach }
}

describe('provider relay idle stop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is idle exactly when no turn, approval or agent-reported background command is open', async () => {
    const r = rig()
    r.detach({ turn: [[T]], command: [] })
    r.line(command('item/started', 'inProgress'))
    r.line(turn('turn/started', 'child-thread'))
    r.line(turn('turn/completed'))
    r.line(turn('turn/completed', 'child-thread'))
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    // The command outlived its turn: a background shell or dev server keeps the agent.
    expect(r.stop).not.toHaveBeenCalled()
    r.line(command('item/completed', 'completed'))
    r.state.pending = 1
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(r.stop).not.toHaveBeenCalled()
    // Detached, only the agent's own line can settle a request; the busy check waits for it.
    r.state.pending = 0
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(r.stop).not.toHaveBeenCalled()
    r.line(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 1 } }))
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000)
    expect(r.stop).toHaveBeenCalledTimes(1)
  })

  it('counts lines the app had not acked at detach, and never stops without an open set', async () => {
    const late = rig()
    late.line(turn('turn/started'))
    late.detach({ turn: [], command: [] })
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(late.stop).not.toHaveBeenCalled()

    const journaled = rig()
    journaled.line(turn('turn/started'))
    journaled.line(turn('turn/completed'))
    journaled.state.unacked = []
    journaled.detach({ turn: [], command: [] })
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1_000)
    expect(journaled.stop).toHaveBeenCalledTimes(1)

    const spilled = rig()
    spilled.state.unacked = null
    spilled.detach({ turn: [], command: [] })
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(spilled.stop).not.toHaveBeenCalled()

    const dropped = rig()
    dropped.detach()
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(dropped.stop).not.toHaveBeenCalled()
  })

  it('counts an app request named as work (an ACP turn) until the agent answers it', () => {
    const pending = new ProviderRelayPendingRequests()
    pending.workMethods = new Set(['session/prompt'])
    pending.observeClientData('{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{}}\n')
    pending.observeClientData('{"jsonrpc":"2.0","id":8,"method":"session/cancel","params":{}}\n')
    const agent = (line: string, seq: number) => pending.observeAgentLine({ seq, line })
    agent('{"jsonrpc":"2.0","method":"session/update","params":{"update":{}}}', 1)
    agent('{"jsonrpc":"2.0","id":8,"result":null}', 2)
    expect(pending.working.size).toBe(1)
    agent('{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}', 3)
    expect(pending.working.size).toBe(0)
  })

  it('still counts a background command from before the first restart at the second quit', async () => {
    const r = rig()
    r.detach({ turn: [], command: [[T, 'cmd-1']] })
    // The next launch attaches: its session never saw cmd-1 start, so the daemon hands it over.
    r.state.attached = true
    r.idle.disarm()
    const carried = new ProviderRelayCarriedWork(CODEX_RELAY_WORK_MARKERS.markers)
    carried.take(r.idle.carriedWork().openWork)
    const second = carried.merge({ turn: [], command: [] })
    r.detach(second ?? undefined)
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(r.stop).not.toHaveBeenCalled()

    // Seen ending while attached, it is dropped, and the chat can idle-stop again.
    carried.observe(command('item/completed', 'completed'))
    expect(carried.merge({ turn: [], command: [] })).toEqual({ turn: [], command: [] })
  })

  it('names a background command that ended while detached, once only, so the next app settles it', () => {
    const r = rig()
    r.detach({ turn: [], command: [[T, 'cmd-1']] })
    r.line(command('item/completed', 'completed'))
    r.state.attached = true
    r.idle.disarm()
    expect(r.idle.carriedWork()).toEqual({
      openWork: { turn: [], command: [] },
      endedWork: { command: [[T, 'cmd-1']] }
    })
    // That app restated and settled it; its own detach and the attach after list nothing ended.
    r.detach({ turn: [], command: [] })
    r.state.attached = true
    r.idle.disarm()
    expect(r.idle.carriedWork().endedWork).toBeUndefined()

    // An app killed after it was handed an end (its stream dropped, so nothing was tracked) may
    // have acked that end: the next app is never told to restate it.
    r.detach({ turn: [], command: [[T, 'cmd-1']] })
    r.line(command('item/completed', 'completed'))
    r.state.attached = true
    r.idle.disarm()
    expect(r.idle.carriedWork().endedWork).toEqual({ command: [[T, 'cmd-1']] })
    r.state.attached = false
    r.idle.arm(null)
    r.state.attached = true
    r.idle.disarm()
    expect(r.idle.carriedWork().endedWork).toBeUndefined()
  })
})
