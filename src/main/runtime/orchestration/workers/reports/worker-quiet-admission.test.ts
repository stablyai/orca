import { expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'
import { startWorkerQuietWatch } from './worker-quiet-watch'

const fixture = runtimeFixture()

it.each([
  [100, 0],
  [1000, 0],
  [100, 1],
  [1000, 1]
])(
  'bounds separated status/title events with %i ordinary working panes and chats and %i worker',
  async (population, working) => {
    const { db, chat, changes } = fixture
    fixture.workers(working)
    for (let n = 0; n < population; n++) {
      fixture.terminal(`ordinary-pane-${n}`, `term_ordinary_${n}`)
      chat.handles.add(`ordinary-chat-${n}`)
    }
    const titles = new Set<() => void>()
    const inventory = vi.fn(() => fixture.panes.keys())
    const local = vi.spyOn(db, 'getActiveDispatchForTerminal')
    const remote = vi.spyOn(db, 'findActiveRemoteAttachmentForPane')
    fixture.start({
      readPaneKeys: inventory,
      subscribeTitleStatus: (wake) => {
        titles.add(wake)
        return () => titles.delete(wake)
      }
    })
    const event = () => {
      changes.notify(new Set(['status']))
      changes.notify()
      for (const wake of titles) {
        wake()
      }
    }
    for (let n = 0; n < 1200; n++) {
      event()
      await vi.advanceTimersByTimeAsync(100)
    }
    // Three passes: one terminal seek and two supported chat-address seeks per candidate.
    expect(inventory).toHaveBeenCalledTimes(3)
    expect(local).toHaveBeenCalledTimes((population * 3 + working) * 3)
    expect(remote).toHaveBeenCalledTimes(population * 2 * 3)
    if (!working) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(inventory).toHaveBeenCalledTimes(3)
    }
    event()
    fixture.stop()
    inventory.mockClear()
    local.mockClear()
    remote.mockClear()
    for (let n = 0; n < 100; n++) {
      event()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(titles.size).toBe(0)
    expect(inventory).not.toHaveBeenCalled()
    expect(local).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
  }
)

it('admits a newly working chat within one interval without event-driven postponement', async () => {
  const { db, chat, changes } = fixture
  const { run } = fixture.workers(1)
  chat.status = 'idle'
  fixture.start()
  await vi.advanceTimersByTimeAsync(1000)
  chat.status = 'working'
  for (let n = 0; n < 60; n++) {
    changes.notify(new Set(['status']))
    await vi.advanceTimersByTimeAsync(1000)
  }
  expect(chat.progress).toHaveBeenCalledTimes(1)
  for (let n = 0; n < 900; n++) {
    changes.notify(new Set(['status']))
    await vi.advanceTimersByTimeAsync(1000)
  }
  const notices = db.getUnreadRunMailbox(run.id, 100, ['status'])
  expect(notices).toHaveLength(1)
  expect(JSON.parse(notices[0]!.payload!).quietNotice.observedAt).toBe(900_000)
})

it('keeps idle admission monotonic across wall-clock jumps and preserves failure backoff', async () => {
  let wake = () => {}
  const sweep = vi.fn<() => boolean>().mockReturnValue(false)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const stop = startWorkerQuietWatch({
    sweep,
    subscribe: (listener) => {
      wake = listener
      return () => {}
    }
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(-9_000_000)
    wake()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(sweep).toHaveBeenCalledTimes(1)
    vi.setSystemTime(9_000_000)
    wake()
    sweep.mockImplementationOnce(() => {
      throw new Error('temporary failure')
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    for (let n = 0; n < 119; n++) {
      wake()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(sweep).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(sweep).toHaveBeenCalledTimes(3)
  } finally {
    stop()
  }
})
