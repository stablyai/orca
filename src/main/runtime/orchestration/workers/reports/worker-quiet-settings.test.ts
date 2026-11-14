import { expect, it, vi } from 'vitest'
import { runtimeFixture } from './worker-quiet-runtime.test-fixture'

const fixture = runtimeFixture()

it('suppresses notices while Off and preserves episode ordinals and budget across live toggles', () => {
  const { db, changes } = fixture
  const { run } = fixture.workers(1)
  fixture.setMinutes(undefined)
  fixture.start()
  changes.notify()
  vi.advanceTimersByTime(60_000)
  const notices = () =>
    db
      .getUnreadRunMailbox(run.id, 100, ['status'])
      .map((mail) => JSON.parse(mail.payload!).quietNotice)
  expect(notices()).toEqual([])
  fixture.setMinutes(1)
  vi.advanceTimersByTime(60_000)
  expect(notices()).toMatchObject([{ ordinal: 1, observedAt: 120_000 }])
  fixture.setMinutes(0)
  changes.notify()
  vi.advanceTimersByTime(600_000)
  expect(notices()).toHaveLength(1)
  fixture.setMinutes(1)
  vi.advanceTimersByTime(60_000)
  expect(notices()).toHaveLength(1)
  vi.advanceTimersByTime(60_000)
  expect(notices()).toMatchObject([
    { ordinal: 1, observedAt: 120_000 },
    { ordinal: 2, observedAt: 840_000 }
  ])
  fixture.setMinutes(0)
  vi.advanceTimersByTime(600_000)
  fixture.setMinutes(1)
  vi.advanceTimersByTime(600_000)
  expect(notices()).toHaveLength(2)
  fixture.chat.progress.mockReturnValue({ turnStartedAt: 0, lastProducerEventAt: 2_040_000 })
  vi.advanceTimersByTime(60_000)
  expect(notices()).toMatchObject([
    { ordinal: 1 },
    { ordinal: 2 },
    { ordinal: 3, observedAt: 2_100_000 }
  ])
})

it('does not bypass the watch failure deadline when Off is toggled back On', () => {
  const { db } = fixture
  const { run } = fixture.workers(1)
  fixture.setMinutes(1)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const database = vi
    .fn(() => db)
    .mockImplementationOnce(() => {
      throw new Error('temporarily unavailable')
    })
  fixture.start({ getDb: database })
  vi.advanceTimersByTime(5_000)
  fixture.setMinutes(0)
  vi.advanceTimersByTime(5_000)
  fixture.setMinutes(1)
  vi.advanceTimersByTime(109_000)
  expect(db.getUnreadRunMailbox(run.id, 100, ['status'])).toEqual([])
  vi.advanceTimersByTime(1_000)
  const notices = db.getUnreadRunMailbox(run.id, 100, ['status'])
  expect(notices).toHaveLength(1)
  expect(JSON.parse(notices[0]!.payload!).quietNotice).toMatchObject({
    ordinal: 1,
    observedAt: 120_000
  })
})
