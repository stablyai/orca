import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setClaudeAccountSessionMovedListener } from './claude-session-mover-history'
import { setClaudeSessionMoveStatsRecorder } from './claude-session-move-stats'
import { setup, state, limits, PANE_1, PANE_2 } from './claude-session-mover-test-fixture'
import {
  CLAUDE_POOL_REBALANCE_QUIET_MS,
  CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS,
  CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS
} from './claude-session-mover-policy'

describe('createClaudeSessionMover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  })
  afterEach(() => {
    setClaudeAccountSessionMovedListener(null)
    setClaudeSessionMoveStatsRecorder(null)
    vi.useRealTimers()
  })

  it('moves an idle session whose own (non-selected) account is over the line to the account with the most room', async () => {
    const moved: unknown[] = []
    setClaudeAccountSessionMovedListener((payload) => {
      moved.push(payload)
    })
    const { mover, session, publish, move, notices } = setup()
    session('pty-1', PANE_1, 'b')
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(1)
    expect(move.mock.calls[0]![0]).toMatchObject({
      ptyId: 'pty-1',
      paneKey: PANE_1,
      toAccountId: 'c',
      providerSession: { key: 'session_id', id: 'sess-pty-1' }
    })
    expect(notices.map((notice) => notice.kind)).toEqual(['moved'])
    expect(mover.lastDecisions()).toEqual([
      expect.objectContaining({
        ptyId: 'pty-new',
        fromAccountId: 'b',
        toAccountId: 'c',
        window: 'session',
        percent: 96,
        line: 95,
        reason: 'moved'
      })
    ])
    expect(moved).toEqual([
      {
        ptyId: 'pty-new',
        fromAccountId: 'b',
        toAccountId: 'c',
        previousPtyId: 'pty-1'
      }
    ])
  })

  it('waits mid-turn and moves once the pane reports done', async () => {
    const { mover, session, publish, setStatus, move } = setup()
    session('pty-1', PANE_1, 'b', 'working')
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).not.toHaveBeenCalled()
    expect(mover.lastDecisions()[0]?.reason).toBe('wait:mid-turn')
    setStatus(PANE_1, 'done')
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('moves a pinned session only at the limit', async () => {
    const { mover, session, publish, move } = setup()
    session('pty-1', PANE_1, 'b', 'done', true)
    mover.start()
    publish(state(30, { b: limits(93), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).not.toHaveBeenCalled()
    publish(state(30, { b: limits(100), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('flips a proxy slot during a turn and keeps the same pty on the assigned account', async () => {
    const proxyMove = vi.fn(async (request: { ptyId: string }) => ({
      kind: 'moved' as const,
      newPtyId: request.ptyId
    }))
    const moved: unknown[] = []
    setClaudeAccountSessionMovedListener((payload) => {
      moved.push(payload)
    })
    const { mover, session, publish, move, notices, records } = setup({
      proxyStrategy: { move: proxyMove }
    })
    session('pty-1', PANE_1, 'a', 'working')
    records[0]!.proxySlot = 'slot-1'
    records[0]!.assignedAccountId = 'b'
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).not.toHaveBeenCalled()
    expect(proxyMove).toHaveBeenCalledTimes(1)
    expect(notices[0]).toMatchObject({ kind: 'moved', restartless: true, detail: 'pty-1' })
    expect(mover.lastDecisions()[0]).toMatchObject({
      ptyId: 'pty-1',
      fromAccountId: 'b',
      toAccountId: 'c',
      reason: 'moved'
    })
    expect(moved).toEqual([{ ptyId: 'pty-1', fromAccountId: 'b', toAccountId: 'c' }])
  })

  it('lets one target take one session at a time', async () => {
    const { mover, session, publish, move } = setup()
    session('pty-1', PANE_1, 'b')
    session('pty-2', PANE_2, 'b')
    mover.start()
    publish(state(90, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    // a has 5 points of room, under the ten-point minimum gain; c is claimed by the first session.
    expect(move).toHaveBeenCalledTimes(1)
    expect(mover.lastDecisions().find((decision) => decision.ptyId === 'pty-2')?.reason).toBe(
      'stay'
    )
    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS)
    publish(state(90, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(2)
    expect(move.mock.calls[1]![0].ptyId).toBe('pty-2')
  })

  it("asks for a reading when the session's account is stale, and stays until it arrives", async () => {
    const { mover, session, publish, move, fetchInactive } = setup()
    session('pty-1', PANE_1, 'b')
    mover.start()
    publish(state(30, { b: limits(96, Date.now() - 16 * 60_000), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(fetchInactive).toHaveBeenCalledTimes(1)
    expect(move).not.toHaveBeenCalled()
    publish(state(30, { b: limits(96, Date.now() - 16 * 60_000), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(fetchInactive).toHaveBeenCalledTimes(1)
  })

  it('does nothing when off; asks on a desktop; acts on a headless host', async () => {
    const off = setup({ setting: 'off' })
    off.session('pty-1', PANE_1, 'b')
    off.mover.start()
    off.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(off.move).not.toHaveBeenCalled()
    expect(off.notices).toEqual([])

    const ask = setup({ setting: 'ask' })
    ask.session('pty-1', PANE_1, 'b')
    ask.mover.start()
    ask.publish(state(30, { b: limits(96), c: limits(20) }))
    ask.publish(state(30, { b: limits(97), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(ask.move).not.toHaveBeenCalled()
    expect(ask.notices.map((notice) => notice.kind)).toEqual(['ask'])

    const headless = setup({ setting: 'ask', headless: true })
    headless.session('pty-1', PANE_1, 'b')
    headless.mover.start()
    headless.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(headless.move).toHaveBeenCalledTimes(1)
  })

  it('marks a failed move and retries only after the hold', async () => {
    const seen: { strategy: string; rebalance: boolean; failed: boolean }[] = []
    setClaudeSessionMoveStatsRecorder((stat) => seen.push(stat))
    const { mover, session, publish, move, notices, log } = setup()
    move.mockResolvedValueOnce({
      kind: 'failed',
      reason: 'owner-changed',
      error: 'terminal_pane_owner_changed'
    })
    session('pty-1', PANE_1, 'b')
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(notices.map((notice) => notice.kind)).toEqual(['failed'])
    expect(notices[0]?.moves?.[0]).toMatchObject({ ptyId: 'pty-1', reason: 'failed' })
    expect(notices[0]?.paneKey).toBe(PANE_1)
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('terminal_pane_owner_changed'),
      expect.objectContaining({ reason: 'failed' })
    )
    publish(state(30, { b: limits(97), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS)
    publish(state(30, { b: limits(97), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).toHaveBeenCalledTimes(2)
    expect(seen).toEqual([
      { strategy: 'resume', rebalance: false, failed: true },
      { strategy: 'resume', rebalance: false, failed: false }
    ])
  })

  it('skips a session with no conversation to resume, with a reason', async () => {
    const { mover, session, publish, move, notices, setProviderSessions } = setup()
    session('pty-1', PANE_1, 'b')
    setProviderSessions([])
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(move).not.toHaveBeenCalled()
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'skipped', ptyId: 'pty-1', detail: 'no-provider-session' })
    ])
  })

  it('learns a session Orca did not route from its transcript and treats it as pinned', async () => {
    const { mover, publish, move, records, setProviderSessions } = setup()
    setProviderSessions([
      {
        paneKey: PANE_2,
        sessionId: 'sess-x',
        transcriptPath: '/profiles/b/home/projects/x/sess-x.jsonl'
      }
    ])
    mover.start()
    publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(records).toEqual([
      expect.objectContaining({
        ptyId: 'pty-2',
        accountId: 'b',
        pinned: true,
        source: 'transcript'
      })
    ])
    expect(move).not.toHaveBeenCalled()
  })

  it('keeps a resume session and a pool that is off on the 95/90 lines', async () => {
    const resume = setup({ pool: 'on' })
    resume.session('pty-1', PANE_1, 'b')
    resume.mover.start()
    resume.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(resume.move).not.toHaveBeenCalled()
    expect(resume.mover.lastDecisions()[0]?.reason).toBe('stay')

    const proxyMove = vi.fn(async (request: { ptyId: string }) => ({
      kind: 'moved' as const,
      newPtyId: request.ptyId
    }))
    const off = setup({ pool: 'off', proxyStrategy: { move: proxyMove } })
    off.session('pty-1', PANE_1, 'b')
    off.records[0]!.proxySlot = 'slot-1'
    off.mover.start()
    off.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(proxyMove).not.toHaveBeenCalled()
    expect(off.mover.lastDecisions()[0]?.reason).toBe('stay')
  })

  it('rebalances a proxy session onto the freer account and names that in the notice', async () => {
    const seen: { strategy: string; rebalance: boolean; failed: boolean }[] = []
    setClaudeSessionMoveStatsRecorder((stat) => seen.push(stat))
    const proxyMove = vi.fn(async (request: { ptyId: string }) => ({
      kind: 'moved' as const,
      newPtyId: request.ptyId
    }))
    const f = setup({ pool: 'on', proxyStrategy: { move: proxyMove } })
    f.session('pty-1', PANE_1, 'b', 'done', false, undefined, false, Date.now() - 3 * 60_000)
    f.records[0]!.proxySlot = 'slot-1'
    f.mover.start()
    f.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(f.move).not.toHaveBeenCalled()
    expect(proxyMove).toHaveBeenCalledTimes(1)
    expect(proxyMove.mock.calls[0]?.[0]).toMatchObject({ ptyId: 'pty-1', toAccountId: 'c' })
    expect(f.notices[0]).toMatchObject({
      kind: 'moved',
      balance: true,
      restartless: true,
      to: { id: 'c' }
    })
    expect(f.mover.lastDecisions()[0]).toMatchObject({
      ptyId: 'pty-1',
      fromAccountId: 'b',
      toAccountId: 'c',
      reason: 'rebalance'
    })
    expect(f.notices[0]?.moves).toEqual(f.mover.lastDecisions())
    expect(seen).toEqual([{ strategy: 'proxy', rebalance: true, failed: false }])
  })

  it('asks before a rebalance when the setting is ask', async () => {
    const proxyMove = vi.fn(async (request: { ptyId: string }) => ({
      kind: 'moved' as const,
      newPtyId: request.ptyId
    }))
    const f = setup({ pool: 'on', setting: 'ask', proxyStrategy: { move: proxyMove } })
    f.session('pty-1', PANE_1, 'b')
    f.records[0]!.proxySlot = 'slot-1'
    f.mover.start()
    f.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(proxyMove).not.toHaveBeenCalled()
    expect(f.notices[0]).toMatchObject({ kind: 'ask', balance: true, to: { id: 'c' } })
    expect(f.mover.lastDecisions()[0]?.reason).toBe('ask')
  })

  it('leaves a proxy session alone until two minutes after its last turn', async () => {
    const proxyMove = vi.fn(async (request: { ptyId: string }) => ({
      kind: 'moved' as const,
      newPtyId: request.ptyId
    }))
    const f = setup({ pool: 'on', proxyStrategy: { move: proxyMove } })
    f.session(
      'pty-1',
      PANE_1,
      'b',
      'done',
      false,
      undefined,
      false,
      Date.now() - CLAUDE_POOL_REBALANCE_QUIET_MS + 1
    )
    f.records[0]!.proxySlot = 'slot-1'
    f.mover.start()
    f.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(proxyMove).not.toHaveBeenCalled()
    expect(f.mover.lastDecisions()[0]?.reason).toBe('stay')

    vi.setSystemTime(Date.now() + CLAUDE_POOL_REBALANCE_QUIET_MS)
    f.publish(state(50, { b: limits(60), c: limits(5) }))
    await vi.runAllTimersAsync()
    expect(proxyMove).toHaveBeenCalledTimes(1)
    expect(f.mover.lastDecisions()[0]?.reason).toBe('rebalance')
  })
})
