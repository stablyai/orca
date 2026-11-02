import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT
} from '../../shared/agent-launch/startup/agent-prompt-injection'
import { getDefaultSettings } from '../../shared/constants'
import {
  createResumeMoveStrategy,
  type ClaudeSessionMoveOutcome
} from './claude-session-move-strategy'
import { CLAUDE_SESSION_MOVE_HANDOFF_TIMEOUT_MS } from './claude-session-move-handoff'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { account, setup, state, limits, PANE_1, PANE_2 } from './claude-session-mover-test-fixture'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import {
  CLAUDE_POOL_REBALANCE_COOLDOWN_MS,
  CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS,
  CLAUDE_SESSION_MOVE_COOLDOWN_MS,
  CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS,
  CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS
} from './claude-session-mover-policy'

describe('session mover lifecycle and metadata', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the matching provider session folder and effort when joining hook identities', async () => {
    const metadata = {
      key: 'session_id' as const,
      id: 'sess-pty-1',
      cwd: '/recorded/run',
      effort: 'high' as const
    }
    const f = setup({
      getStatusSnapshotForPane: () => [
        {
          paneKey: PANE_1,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          providerSession: { key: 'session_id', id: 'other', cwd: '/wrong' }
        },
        {
          paneKey: PANE_1,
          state: 'done',
          prompt: '',
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          providerSession: metadata
        }
      ]
    })
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(f.move.mock.calls[0]?.[0].providerSession).toMatchObject(metadata)
  })

  it('keeps the cooldown after the registry replaces the old PTY with the new owner', async () => {
    const f = setup()
    f.session('pty-1', PANE_1, 'b')
    f.move.mockImplementationOnce(async () => {
      const old = f.records[0]!
      f.records.splice(0, 1, { ...old, ptyId: 'pty-new', accountId: 'c' })
      return { kind: 'moved', newPtyId: 'pty-new' }
    })
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(f.mover.lastDecisions()).toEqual([
      expect.objectContaining({ ptyId: 'pty-new', reason: 'moved' })
    ])
    f.publish(state(30, { b: limits(20), c: limits(96) }))
    await vi.runAllTimersAsync()
    expect(f.move).toHaveBeenCalledTimes(1)
    expect(f.mover.lastDecisions()[0]).toMatchObject({ ptyId: 'pty-new', reason: 'stay' })
    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_COOLDOWN_MS)
    f.publish(state(30, { b: limits(20), c: limits(96) }))
    await vi.runAllTimersAsync()
    expect(f.move).toHaveBeenCalledTimes(2)
  })

  it('holds the pane while its new PTY is published before the move promise settles', async () => {
    const f = setup()
    const pending = Promise.withResolvers<ClaudeSessionMoveOutcome>()
    f.move.mockReturnValueOnce(pending.promise)
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    const old = f.records[0]!
    f.records.splice(0, 1, { ...old, ptyId: 'pty-new', accountId: 'c' })
    f.publish(state(30, { b: limits(96), c: limits(96) }))
    expect(f.move).toHaveBeenCalledTimes(1)
    pending.resolve({ kind: 'moved', newPtyId: 'pty-new' })
    await vi.runAllTimersAsync()
    expect(f.mover.lastDecisions()).toEqual([
      expect.objectContaining({ ptyId: 'pty-new', reason: 'moved' })
    ])
  })

  it('unsubscribes and cancels queued usage reads when stopped', async () => {
    const f = setup()
    f.session('pty-1', PANE_1, 'b')
    const stop = f.mover.start()
    f.publish(state(30, { b: limits(96, Date.now() - 16 * 60_000), c: limits(20) }))
    stop()
    await vi.runAllTimersAsync()
    expect(f.fetchInactive).not.toHaveBeenCalled()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    f.setStatus(PANE_1, 'done')
    f.mover.evaluate()
    await vi.runAllTimersAsync()
    expect(f.move).not.toHaveBeenCalled()
  })

  it('moves a monitoring pane whose main agent is already done', async () => {
    const f = setup()
    f.session('pty-1', PANE_1, 'b', 'working', false, 'done')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(f.mover.lastDecisions()[0]?.reason).not.toBe('wait:mid-turn')
    expect(f.move).toHaveBeenCalledTimes(1)
  })

  it('waits out live background work, then moves, and moves at once at the limit', async () => {
    const waiting = setup()
    waiting.session('pty-1', PANE_1, 'b', 'working', false, 'done', true)
    waiting.mover.start()
    waiting.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(waiting.move).not.toHaveBeenCalled()
    expect(waiting.mover.lastDecisions()[0]?.reason).toBe('wait:background-work')

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS - 1)
    waiting.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(waiting.move).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 1)
    waiting.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(waiting.move).toHaveBeenCalledTimes(1)
    expect(waiting.notices[0]).toMatchObject({
      kind: 'moved',
      detail: 'pty-new (wait:background-work)'
    })

    const limited = setup({ setting: 'ask' })
    limited.session('pty-1', PANE_1, 'b', 'working', false, 'done', true)
    limited.mover.start()
    limited.publish(state(30, { b: limits(100), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(limited.move).not.toHaveBeenCalled()
    expect(limited.notices).toEqual([
      expect.objectContaining({
        kind: 'ask',
        detail: 'session 100% (wait:background-work)'
      })
    ])
  })

  it('restarts the background wait when the work ends', async () => {
    const f = setup()
    f.session('pty-1', PANE_1, 'b', 'working', false, 'done', true)
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    expect(f.mover.lastDecisions()[0]?.reason).toBe('wait:background-work')

    vi.setSystemTime(Date.now() + 2 * 60_000)
    f.publish(state(30, { b: limits(20), c: limits(20) }))
    expect(f.mover.lastDecisions()[0]?.reason).toBe('stay')
    expect(f.move).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS)
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    expect(f.move).toHaveBeenCalledTimes(1)

    const restarted = setup()
    restarted.session('pty-1', PANE_1, 'b', 'working', false, 'done', true)
    restarted.mover.start()
    restarted.publish(state(30, { b: limits(96), c: limits(20) }))
    expect(restarted.mover.lastDecisions()[0]?.reason).toBe('wait:background-work')

    vi.setSystemTime(Date.now() + 2 * 60_000)
    restarted.setBackgroundWork(PANE_1, false, false)
    restarted.publish(state(30, { b: limits(20), c: limits(20) }))
    expect(restarted.mover.lastDecisions()[0]?.reason).toBe('stay')

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS)
    restarted.setBackgroundWork(PANE_1, true, false)
    restarted.publish(state(30, { b: limits(96), c: limits(20) }))
    await vi.runAllTimersAsync()
    expect(restarted.move).not.toHaveBeenCalled()
    expect(restarted.mover.lastDecisions()[0]?.reason).toBe('wait:background-work')
  })

  it('records under-line, read-usage and off decisions without moving', async () => {
    const f = setup()
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(20), c: limits(20) }))
    expect(f.mover.lastDecisions()[0]?.reason).toBe('stay')
    f.publish(state(30, { b: limits(96, Date.now() - 16 * 60_000), c: limits(20) }))
    expect(f.mover.lastDecisions()[0]?.reason).toBe('read-usage')
    f.settings.claudeSessionMover = 'off'
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    expect(f.mover.lastDecisions()[0]?.reason).toBe('off')
    expect(f.mover.lastDecisions()).toHaveLength(1)
    f.records.splice(0)
    expect(f.mover.lastDecisions()).toEqual([])
    await vi.runAllTimersAsync()
    expect(f.move).not.toHaveBeenCalled()
  })
})

const CLAUDE_COMPOSER = '\u001b[?2031h❯\u00a0'

function hookRow(
  receivedAt: number,
  extra: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey: PANE_1,
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    providerSession: { key: 'session_id', id: 'sess-pty-1' },
    workingMode: 'monitoring',
    subagents: [{ id: 'child-1', agentType: 'explore', state: 'working', startedAt: 1 }],
    ...extra
  }
}

function handoffRig(screen: () => string | null) {
  const snapshots: AgentStatusIpcPayload[] = []
  const write = vi.fn<(ptyId: string, data: string, inputKind: string) => boolean>(() => true)
  const serializeBuffer = vi.fn(async () => {
    const data = screen()
    return data === null ? null : { data, cols: 80, rows: 24 }
  })
  const spawn = vi.fn(async () => ({ id: 'pty-new' as const }))
  const strategy = createResumeMoveStrategy({
    getController: () => ({
      spawn,
      getCwd: async () => '/fixture',
      getSize: () => ({ cols: 80, rows: 24 }),
      write,
      serializeBuffer
    }),
    getSettings: () => getDefaultSettings('/tmp'),
    platform: 'darwin',
    hooks: {
      getStatusSnapshotForPane: () => snapshots,
      getProviderSessionIdentities: () => [{ paneKey: PANE_1, sessionId: 'sess-pty-1' }]
    }
  })
  return { snapshots, write, serializeBuffer, spawn, strategy }
}

const PANE_3 = makePaneKey('tab-3', '55555555-5555-4555-8555-555555555555')

describe('pool rebalance lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves one of three panes on a hot account per claim cooldown until they sit on the freer one', async () => {
    const moved: string[] = []
    const registry: { records: ReturnType<typeof setup>['records'] } = { records: [] }
    const f = setup({
      pool: 'on',
      accounts: [account('b'), account('c')],
      proxyStrategy: {
        async move(request) {
          moved.push(request.ptyId)
          const index = registry.records.findIndex((entry) => entry.ptyId === request.ptyId)
          const previous = registry.records[index]
          if (previous) {
            registry.records.splice(index, 1, {
              ...previous,
              accountId: request.toAccountId,
              assignedAccountId: request.toAccountId
            })
          }
          return { kind: 'moved', newPtyId: request.ptyId }
        }
      }
    })
    registry.records = f.records
    f.session('pty-1', PANE_1, 'b')
    f.session('pty-2', PANE_2, 'b')
    f.session('pty-3', PANE_3, 'b')
    for (const record of f.records) {
      record.proxySlot = `slot-${record.ptyId}`
    }
    f.mover.start()
    const reading = () => state(40, { b: limits(60), c: limits(5) })
    f.publish(reading())
    await vi.runAllTimersAsync()
    expect(moved).toEqual(['pty-1'])
    expect(f.notices).toEqual([
      expect.objectContaining({
        kind: 'moved',
        balance: true,
        restartless: true,
        ptyId: 'pty-1',
        to: expect.objectContaining({ id: 'c' })
      })
    ])
    expect(f.mover.lastDecisions().find((decision) => decision.ptyId === 'pty-1')?.reason).toBe(
      'rebalance'
    )
    expect(f.records.filter((record) => record.accountId === 'c')).toHaveLength(1)

    f.publish(reading())
    await vi.runAllTimersAsync()
    expect(moved).toEqual(['pty-1'])

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS)
    f.publish(reading())
    await vi.runAllTimersAsync()
    expect(moved).toEqual(['pty-1', 'pty-2'])

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS)
    f.publish(reading())
    await vi.runAllTimersAsync()
    expect(moved).toEqual(['pty-1', 'pty-2', 'pty-3'])
    expect(f.records.map((record) => record.accountId)).toEqual(['c', 'c', 'c'])

    vi.setSystemTime(Date.now() + CLAUDE_POOL_REBALANCE_COOLDOWN_MS)
    f.publish(reading())
    await vi.runAllTimersAsync()
    expect(moved).toEqual(['pty-1', 'pty-2', 'pty-3'])
    expect(f.mover.lastDecisions().every((decision) => decision.reason === 'stay')).toBe(true)
    expect(f.move).not.toHaveBeenCalled()
  })
})

describe('session mover handoff note', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the note once after a post-spawn done row, and not when spawn fails', async () => {
    const rig = handoffRig(() => null)
    rig.spawn.mockRejectedValueOnce(new Error('spawn exploded'))
    rig.snapshots.push(hookRow(Date.now()))
    const f = setup({
      strategy: rig.strategy,
      getStatusSnapshotForPane: () => rig.snapshots
    })
    f.setNonAgentTask(PANE_1, true)
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    await f.move.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.write).not.toHaveBeenCalled()
    expect(f.move.mock.calls[0]?.[0].handoff?.endedWork).toEqual({
      workingMode: 'monitoring',
      claudeRunningNonAgentTask: true,
      subagents: [{ id: 'child-1', agentType: 'explore', state: 'working' }]
    })

    vi.setSystemTime(Date.now() + CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS)
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    const second = f.move.mock.results[1]!.value
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.write).not.toHaveBeenCalled()

    rig.snapshots[0] = hookRow(Date.now(), { providerSessionOnly: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(rig.write).not.toHaveBeenCalled()

    rig.snapshots[0] = hookRow(Date.now())
    await vi.advanceTimersByTimeAsync(250)
    await expect(second).resolves.toMatchObject({
      kind: 'moved',
      newPtyId: 'pty-new',
      handoffNote: 'sent'
    })
    expect(rig.write).toHaveBeenCalledTimes(1)
    const [ptyId, data, inputKind] = rig.write.mock.calls[0]!
    expect(ptyId).toBe('pty-new')
    expect(inputKind).toBe('orchestration')
    expect(data.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)).toBe(true)
    expect(data.endsWith(`${AGENT_PROMPT_BRACKETED_PASTE_END}${AGENT_PROMPT_SUBMIT}`)).toBe(true)
    expect(data).toContain('from b@example.com to c@example.com because session 96%')
    expect(data).toContain(
      'monitoring; a background task was still running; explore child-1 (working)'
    )
    expect(rig.serializeBuffer).toHaveBeenCalledWith('pty-new', { scrollbackRows: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(rig.write).toHaveBeenCalledTimes(1)
  })

  it('does not write into a shell prompt even after the resumed session reports done', async () => {
    const rig = handoffRig(() => '$ ')
    rig.spawn.mockImplementation(async () => {
      rig.snapshots[0] = hookRow(Date.now() + 1)
      return { id: 'pty-new' }
    })
    rig.snapshots.push(hookRow(Date.now()))
    const f = setup({
      strategy: rig.strategy,
      getStatusSnapshotForPane: () => rig.snapshots
    })
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    await expect(f.move.mock.results[0]!.value).resolves.toMatchObject({
      kind: 'moved',
      handoffNote: 'unsent'
    })
    expect(rig.write).not.toHaveBeenCalled()
  })

  it('writes on the composer screen when hooks never report the new process', async () => {
    const rig = handoffRig(() => CLAUDE_COMPOSER)
    rig.snapshots.push(hookRow(Date.now()))
    const f = setup({
      strategy: rig.strategy,
      getStatusSnapshotForPane: () => rig.snapshots
    })
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    const pending = f.move.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_MOVE_HANDOFF_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ kind: 'moved', handoffNote: 'sent' })
    expect(rig.write).toHaveBeenCalledTimes(1)
  })

  it('does not write when the timeout screen is neither Claude nor a shell', async () => {
    const rig = handoffRig(() => 'still starting')
    rig.snapshots.push(hookRow(Date.now()))
    const f = setup({
      strategy: rig.strategy,
      getStatusSnapshotForPane: () => rig.snapshots
    })
    f.session('pty-1', PANE_1, 'b')
    f.mover.start()
    f.publish(state(30, { b: limits(96), c: limits(20) }))
    const pending = f.move.mock.results[0]!.value
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_MOVE_HANDOFF_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ kind: 'moved', handoffNote: 'unsent' })
    expect(rig.write).not.toHaveBeenCalled()
  })
})
