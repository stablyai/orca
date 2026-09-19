import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_EDGE_SETTLE_MS,
  ScheduledMessageService,
  type ScheduledMessageNotification,
  type ScheduledMessagePaneTarget
} from './scheduled-message-service'
import { MAX_DELIVERY_ATTEMPTS } from './scheduled-message-delivery-outcome'
import {
  SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS,
  SCHEDULED_MESSAGE_MISSED_GRACE_MS,
  SCHEDULED_MESSAGE_TICK_MS,
  type ScheduledMessage
} from '../shared/scheduled-message-types'

const WORKTREE = 'repo::wt'
const HANDLE = 'handle-1'
const PTY = 'pty-1'
const NOW = 1_700_000_000_000
// What the service asks the send guard for. Only a when-idle send requires the
// agent to still be idle at the write; a clock send was never about idleness.
const CLOCK_SEND = { requireIdleAgent: false, stillWanted: expect.any(Function) }
const IDLE_SEND = { requireIdleAgent: true, stillWanted: expect.any(Function) }

function makeHarness(
  options: { pane?: ScheduledMessagePaneTarget | null; stalled?: boolean } = {}
) {
  let rows: ScheduledMessage[] = []
  let clock = NOW
  let nextId = 0
  const deliver = vi.fn<
    (
      handle: string,
      text: string,
      options: { requireIdleAgent: boolean; stillWanted: () => boolean }
    ) => Promise<void>
  >(() => Promise.resolve())
  const notify = vi.fn<(n: ScheduledMessageNotification) => void>()
  // Mutable so a test can open a pane (or let the agent pick work back up) between
  // two delivery attempts, the way the real runtime does across a wait.
  const agent = {
    pane: options.pane === undefined ? { handle: HANDLE, ptyId: PTY } : options.pane,
    idle: true
  }
  const stall = { stalled: options.stalled === true }
  const deferForUsageLimit = vi.fn<(ptyId: string, handle: string) => Promise<boolean>>(() =>
    Promise.resolve(stall.stalled)
  )
  const snapshots: ScheduledMessage[][] = []
  const service = new ScheduledMessageService({
    store: {
      listScheduledMessages: () => rows,
      putScheduledMessage: (message) => {
        const index = rows.findIndex((row) => row.id === message.id)
        rows = index === -1 ? [...rows, message] : rows.toSpliced(index, 1, message)
      },
      deleteScheduledMessage: (id) => {
        rows = rows.filter((row) => row.id !== id)
      }
    },
    resolveAgentPane: () => Promise.resolve(agent.pane),
    deliver,
    deferForUsageLimit,
    isAgentIdle: () => Promise.resolve(agent.idle),
    createId: () => `msg-${++nextId}`,
    notify,
    onSnapshot: (snapshot) => snapshots.push(snapshot.messages),
    now: () => clock,
    logger: { debug: vi.fn(), warn: vi.fn() }
  })
  return {
    service,
    agent,
    deliver,
    notify,
    stall,
    deferForUsageLimit,
    snapshots,
    rows: () => rows,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('ScheduledMessageService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delivers an at-time message once it comes due and removes the row', async () => {
    const h = makeHarness()
    h.service.add({
      worktreeId: WORKTREE,
      text: 'ship it',
      timing: { kind: 'at', sendAt: NOW + 60_000 }
    })
    h.service.start()
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).not.toHaveBeenCalled()

    h.advance(61_000)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'ship it', CLOCK_SEND)
    expect(h.rows()).toHaveLength(0)
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sent' }))
  })

  it('refuses to send past the grace window and leaves a missed row behind', async () => {
    const h = makeHarness()
    h.service.add({
      worktreeId: WORKTREE,
      text: 'stale',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    // Simulates Orca having been closed: the due moment passed long ago.
    h.advance(SCHEDULED_MESSAGE_MISSED_GRACE_MS + 60_000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({
      status: 'missed',
      failureReason: 'expired-while-closed'
    })
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'missed' }))
  })

  it('sends late but silently inside the grace window', async () => {
    const h = makeHarness()
    h.service.add({ worktreeId: WORKTREE, text: 'ok', timing: { kind: 'at', sendAt: NOW + 1000 } })
    h.advance(SCHEDULED_MESSAGE_MISSED_GRACE_MS - 1000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'ok', CLOCK_SEND)
    expect(h.rows()).toHaveLength(0)
  })

  it('defers rather than typing into a usage-limit stalled pane', async () => {
    const h = makeHarness({ stalled: true })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'later',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.deliver).not.toHaveBeenCalled()
    // Handed the pane so the free "wait for reset" option can be chosen on the
    // way past, instead of the menu just sitting there.
    expect(h.deferForUsageLimit).toHaveBeenCalledWith(PTY, HANDLE)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    h.stall.stalled = false
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'later', CLOCK_SEND)
  })

  it('still delivers when the usage limit outlasts the grace window', async () => {
    // "Send this when the limit expires" is the whole point of the feature, and
    // a real limit outlasts the 10-minute window many times over. Charging that
    // deliberate wait against the "Orca was closed" grace marked every such
    // message `missed` before the limit had a chance to reset.
    const h = makeHarness({ stalled: true })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'resume the migration',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    const ticks = Math.ceil((SCHEDULED_MESSAGE_MISSED_GRACE_MS * 3) / SCHEDULED_MESSAGE_TICK_MS)
    for (let i = 0; i < ticks; i++) {
      h.advance(SCHEDULED_MESSAGE_TICK_MS)
      await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    }
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })
    expect(h.notify).not.toHaveBeenCalled()

    h.stall.stalled = false
    h.advance(SCHEDULED_MESSAGE_TICK_MS)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'resume the migration', CLOCK_SEND)
    expect(h.rows()).toHaveLength(0)
  })

  it('credits the wait that is still open when the grace is checked', async () => {
    // The first defer lands 15s inside the 10-minute grace; one tick later the
    // message is nominally past it, and only the still-open deferral keeps it
    // alive. Banking a wait only when the NEXT defer arrives loses exactly this.
    const h = makeHarness({ stalled: true })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'resume',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(1000 + SCHEDULED_MESSAGE_MISSED_GRACE_MS - 15_000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    h.advance(SCHEDULED_MESSAGE_TICK_MS)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('keeps the wait already served when the user presses Send now', async () => {
    // Send now revives the row for a fresh set of attempts, but the limit it is
    // waiting on does not reset because a button was clicked. Clearing the credit
    // with the attempts marked the row missed on the very next tick.
    const h = makeHarness({ stalled: true })
    const message = h.service.add({
      worktreeId: WORKTREE,
      text: 'resume',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    h.advance(60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    await h.service.sendNow(message.id)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    h.advance(SCHEDULED_MESSAGE_TICK_MS)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    h.stall.stalled = false
    h.advance(SCHEDULED_MESSAGE_TICK_MS)
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'resume', CLOCK_SEND)
  })

  it('gives up once the usage limit outlasts the maximum wait', async () => {
    // Deferring forever is not kindness: past the ceiling the agent's context is
    // as gone as it would be after a long shutdown, so tell the user rather than
    // typing the text in half a day late with nobody watching.
    const h = makeHarness({ stalled: true })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'resume',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    const hour = 60 * 60 * 1000
    for (let waited = 0; waited <= SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS; waited += hour) {
      h.advance(hour)
      await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    }
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({
      status: 'missed',
      failureReason: 'usage-limit-outlasted'
    })
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'missed' }))
  })

  it('fails a due message when the workspace has no live pane', async () => {
    const h = makeHarness({ pane: null })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'nowhere',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'no-pane' })
  })

  it('delivers a when-idle message on the idle edge, after the settle delay', async () => {
    const h = makeHarness()
    h.service.add({ worktreeId: WORKTREE, text: 'on idle', timing: { kind: 'when-idle' } })
    h.service.start()
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    // A tick alone must never fire a when-idle message.
    expect(h.deliver).not.toHaveBeenCalled()

    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'on idle', IDLE_SEND)
  })

  it('sends only one when-idle message per idle edge', async () => {
    const h = makeHarness()
    h.service.add({ worktreeId: WORKTREE, text: 'first', timing: { kind: 'when-idle' } })
    h.advance(1)
    h.service.add({ worktreeId: WORKTREE, text: 'second', timing: { kind: 'when-idle' } })
    h.service.start()

    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'first', IDLE_SEND)

    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).toHaveBeenCalledTimes(2)
    expect(h.deliver).toHaveBeenLastCalledWith(HANDLE, 'second', IDLE_SEND)
  })

  it('retries a permission-prompt rejection, then fails once attempts run out', async () => {
    const h = makeHarness()
    h.deliver.mockRejectedValue(new Error('terminal_guard_permission'))
    h.service.add({
      worktreeId: WORKTREE,
      text: 'wait',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    }
    expect(h.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'send-failed' })
  })

  it('publishes the revived row even when the send that follows defers', async () => {
    // Send now on a failed row is a state change of its own: if the delivery then
    // defers or retries, nothing else emits and the tab keeps the failed label.
    const h = makeHarness()
    h.deliver.mockRejectedValueOnce(new Error('terminal_guard_no_agent'))
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'now',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'failed' })

    h.stall.stalled = true
    h.snapshots.length = 0
    await h.service.sendNow(added.id)

    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.snapshots.at(-1)?.[0]).toMatchObject({ status: 'pending' })
  })

  it('fails immediately when no agent is running rather than typing into a shell', async () => {
    const h = makeHarness()
    h.deliver.mockRejectedValue(new Error('terminal_guard_no_agent'))
    h.service.add({ worktreeId: WORKTREE, text: 'ls', timing: { kind: 'at', sendAt: NOW + 1000 } })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'no-agent' })
  })

  it('sendNow revives a failed row and delivers it', async () => {
    const h = makeHarness({ pane: null })
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'retry me',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'no-pane' })

    // A failed row must not be inert: send-now is the whole point of keeping it,
    // and the user reaches for it precisely once they have opened the terminal
    // whose absence failed the row in the first place.
    h.agent.pane = { handle: HANDLE, ptyId: PTY }
    await h.service.sendNow(added.id)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'retry me', CLOCK_SEND)
    expect(h.rows()).toHaveLength(0)
  })

  it('delivers once when two send-now calls overlap', async () => {
    const h = makeHarness()
    let release = (): void => {}
    h.deliver.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'once',
      timing: { kind: 'when-idle' }
    })

    const first = h.service.sendNow(added.id)
    const second = h.service.sendNow(added.id)
    await vi.advanceTimersByTimeAsync(0)
    release()
    await Promise.all([first, second])

    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.rows()).toHaveLength(0)
  })

  it('waits for the next idle edge when the agent picked work back up while settling', async () => {
    const h = makeHarness()
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'when free',
      timing: { kind: 'when-idle' }
    })
    h.service.start()

    // The edge fired, then the user typed: three seconds later the agent is busy
    // again, and this text would land in the middle of its turn.
    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    h.agent.idle = false
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({ id: added.id, status: 'pending' })

    h.agent.idle = true
    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'when free', IDLE_SEND)
  })

  it('keeps a when-idle row pending when the write guard finds the agent busy', async () => {
    // The last word on idleness belongs to the guard at the write itself, and a
    // refusal there is not a delivery failure: the row keeps its place in the
    // queue and the next edge arms it again.
    const h = makeHarness()
    h.deliver.mockRejectedValueOnce(new Error('terminal_guard_agent_busy'))
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'when free',
      timing: { kind: 'when-idle' }
    })
    h.service.start()

    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.rows()[0]).toMatchObject({ id: added.id, status: 'pending' })
    expect(h.notify).not.toHaveBeenCalled()

    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    expect(h.deliver).toHaveBeenLastCalledWith(HANDLE, 'when free', IDLE_SEND)
    expect(h.rows()).toHaveLength(0)
  })

  it('does not fail the rewritten row when the usage-limit wait runs out mid-check', async () => {
    // Past the ceiling the deferral settles the row it was holding. Settling the
    // captured one would put the sentence the user just rewrote away back on disk.
    const h = makeHarness({ stalled: true })
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'typo',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })

    h.advance(SCHEDULED_MESSAGE_MAX_USAGE_LIMIT_WAIT_MS + 60_000)
    let releaseDefer = (): void => {}
    h.deferForUsageLimit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseDefer = () => resolve(true)
        })
    )
    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)

    h.service.update(added.id, { text: 'fixed' })
    releaseDefer()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.rows()[0]).toMatchObject({ text: 'fixed', status: 'pending' })
    expect(h.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'missed' }))
  })

  it('does not type a row the user deleted while the pane check was in flight', async () => {
    // The usage-limit check reads the pane, which yields. A delete landing in
    // that window has to win: the text would otherwise be typed into the agent
    // with no row left to record that it was.
    const h = makeHarness()
    let releaseDefer = (): void => {}
    h.deferForUsageLimit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseDefer = () => resolve(false)
        })
    )
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'never mind',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    h.service.remove(added.id)
    releaseDefer()
    await vi.advanceTimersByTimeAsync(0)

    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()).toHaveLength(0)
  })

  it('does not send the pre-edit text of a row rewritten mid-delivery', async () => {
    // `update` replaces the row under the same id. An in-flight pass holding the
    // old object would type the sentence the user just rewrote away — and then
    // delete their new row as if it had been sent.
    const h = makeHarness()
    let releaseDefer = (): void => {}
    h.deferForUsageLimit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseDefer = () => resolve(false)
        })
    )
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'typo',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    h.service.update(added.id, { text: 'fixed' })
    releaseDefer()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({ text: 'fixed', status: 'pending' })

    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenCalledWith(HANDLE, 'fixed', CLOCK_SEND)
  })

  it('withdraws text the user rewrote inside the write window', async () => {
    // The identity check before `deliver` is stale by the time the keystrokes
    // leave: the send guard's own probe waits up to a second, and an IPC edit
    // lands inside it. `stillWanted` is that check taken at the write.
    const h = makeHarness()
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'typo',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    let withdrawn = false
    h.deliver.mockImplementationOnce((_handle, _text, options) => {
      h.service.update(added.id, { text: 'fixed' })
      withdrawn = options.stillWanted() === false
      return withdrawn ? Promise.reject(new Error('terminal_send_superseded')) : Promise.resolve()
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(withdrawn).toBe(true)
    expect(h.rows()[0]).toMatchObject({ text: 'fixed', status: 'pending' })
    expect(h.notify).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SCHEDULED_MESSAGE_TICK_MS)
    expect(h.deliver).toHaveBeenLastCalledWith(HANDLE, 'fixed', CLOCK_SEND)
  })

  it('does not spend a delivery attempt on a busy-agent refusal', async () => {
    // The attempt budget exists to end a permission prompt nobody answers. A busy
    // agent says nothing about that, so the busy refusal must leave the budget
    // whole: one busy plus MAX - 1 permission refusals still leaves the row
    // pending, where charging the busy one would have failed it on the last edge.
    const h = makeHarness()
    h.deliver.mockRejectedValueOnce(new Error('terminal_guard_agent_busy'))
    h.deliver.mockRejectedValue(new Error('terminal_guard_permission'))
    h.service.add({ worktreeId: WORKTREE, text: 'when free', timing: { kind: 'when-idle' } })
    h.service.start()

    const refuse = async (): Promise<void> => {
      h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })
      await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)
    }
    for (let edge = 0; edge < MAX_DELIVERY_ATTEMPTS; edge++) {
      await refuse()
    }

    expect(h.deliver).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS)
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })
    expect(h.notify).not.toHaveBeenCalled()

    // The budget still ends: one more permission refusal is the MAX-th charged
    // attempt, and the row fails.
    await refuse()
    expect(h.rows()[0]).toMatchObject({ status: 'failed', failureReason: 'send-failed' })
  })

  it('drops the armed idle timer when the row is retimed to a clock moment', async () => {
    const h = makeHarness()
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'later instead',
      timing: { kind: 'when-idle' }
    })
    h.service.start()
    h.service.handleIdleEdge({ ptyId: PTY, worktreeId: WORKTREE, leafId: 'leaf', tabId: 'tab' })

    h.service.update(added.id, { timing: { kind: 'at', sendAt: NOW + 3_600_000 } })
    await vi.advanceTimersByTimeAsync(IDLE_EDGE_SETTLE_MS)

    expect(h.deliver).not.toHaveBeenCalled()
    expect(h.rows()[0]).toMatchObject({ status: 'pending', timing: { kind: 'at' } })
  })

  it('accepts a text-only edit of a row whose moment has already passed', async () => {
    const h = makeHarness({ pane: null })
    const added = h.service.add({
      worktreeId: WORKTREE,
      text: 'typo',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'failed' })

    // Fixing the wording must not be rejected for a lateness the user did not
    // introduce — the row is failed precisely because its time came and went.
    expect(() => h.service.update(added.id, { text: 'fixed' })).not.toThrow()
    expect(h.rows()[0]).toMatchObject({ text: 'fixed', status: 'pending' })
  })

  it('rejects a schedule beyond the one-year horizon', () => {
    const h = makeHarness()
    expect(() =>
      h.service.add({
        worktreeId: WORKTREE,
        text: 'far future',
        timing: { kind: 'at', sendAt: NOW + 400 * 24 * 60 * 60 * 1000 }
      })
    ).toThrow('send-at-beyond-horizon')
  })

  it('update reschedules a missed row back to pending', async () => {
    const h = makeHarness({ pane: null })
    h.service.add({
      worktreeId: WORKTREE,
      text: 'oops',
      timing: { kind: 'at', sendAt: NOW + 1000 }
    })
    h.advance(2000)
    h.service.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rows()[0]).toMatchObject({ status: 'failed' })

    h.service.update('msg-1', { timing: { kind: 'at', sendAt: NOW + 3_600_000 } })
    expect(h.rows()[0]).toMatchObject({ status: 'pending' })
    // Deleted, not set to undefined — the row must serialize back to disk clean.
    expect(h.rows()[0]).not.toHaveProperty('failureReason')
  })
})
