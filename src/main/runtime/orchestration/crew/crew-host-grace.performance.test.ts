// Perf contract for the crew subscribe stall in 1.4.266 (follow-up to #45290): hide/show must not rebuild.
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { seedLegacyCrewLoad, LEGACY_COORDINATOR } from './legacy-crew-load.test-fixture'
import { CrewReadModel, CREW_HOST_GRACE_MS } from './crew-read-model'
import { subscribeCrew } from './crew-stream'

afterEach(() => vi.useRealTimers())

it('keeps the shared crew host across a chat hidden and shown 20 times, then lets go of it', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  seedLegacyCrewLoad(f.db, { dispatches: 50, creatorTasks: 10, mail: 200 })
  let builds = 0
  let watching = 0
  const model = new CrewReadModel(
    (previous) => {
      if (!previous) {
        builds++
      }
      return f.deps
    },
    (wake) => {
      watching++
      const stop = f.db.crewChanges.subscribe(wake)
      return () => {
        watching--
        stop()
      }
    }
  )
  const showAndHide = () =>
    subscribeCrew(
      () => model.read(LEGACY_COORDINATOR),
      (wake) => model.subscribe(wake, LEGACY_COORDINATOR),
      () => {}
    )()
  for (let i = 0; i < 20; i++) {
    showAndHide()
  }
  expect({ builds, watching, timers: vi.getTimerCount() }).toEqual({
    builds: 1,
    watching: 1,
    timers: 1
  })
  vi.advanceTimersByTime(CREW_HOST_GRACE_MS)
  // Nobody listening: no watch, no timer.
  expect({ watching, timers: vi.getTimerCount() }).toEqual({ watching: 0, timers: 0 })
  showAndHide()
  expect(builds).toBe(2)
})
