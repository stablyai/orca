// Perf contracts for the crew subscribe stall in 1.4.266 (follow-up to #45290): hide/show and opening
// another chat must not rebuild the crew host.
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
  const show = () =>
    subscribeCrew(
      () => model.read(LEGACY_COORDINATOR),
      (wake) => model.subscribe(wake, LEGACY_COORDINATOR),
      () => {}
    )
  for (let i = 0; i < 20; i++) {
    const hide = show()
    hide()
    hide()
  }
  expect({ builds, watching, timers: vi.getTimerCount() }).toEqual({
    builds: 1,
    watching: 1,
    timers: 1
  })
  vi.advanceTimersByTime(CREW_HOST_GRACE_MS)
  // Nobody listening: no watch, no timer.
  expect({ watching, timers: vi.getTimerCount() }).toEqual({ watching: 0, timers: 0 })
  show()()
  expect(builds).toBe(2)
})

it('opens a chat beside a mounted one without rebuilding for an unrelated Dispatch', () => {
  const f = fixture()
  f.assign('term_worker')
  let builds = 0
  const model = new CrewReadModel((previous) => {
    if (!previous) {
      builds++
    }
    return f.deps
  }, f.db.crewChanges.subscribe)
  const show = (party: string) =>
    subscribeCrew(
      () => model.read(party),
      (wake) => model.subscribe(wake, party),
      () => {}
    )
  const mounted = show('term_coord')
  const other = f.db.createRun({
    objective: 'Other',
    coordinatorHandle: 'term_peer',
    coordinatorPaneKey: null
  })
  const task = f.db.createTask({ runId: other.id, spec: 'Other work' })
  f.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_helper',
    creator: { kind: 'terminal', handle: 'term_peer' },
    maxDepth: 10
  })
  for (const party of ['term_outbound', 'term_grandchild', 'term_worker']) {
    show(party)()
  }
  expect(builds).toBe(1)
  mounted()
})

it('stops filtering for a chat that closed beside an open one', () => {
  const f = fixture()
  f.assign('term_worker')
  const other = f.db.createRun({
    objective: 'Other',
    coordinatorHandle: 'term_peer',
    coordinatorPaneKey: null
  })
  const task = f.db.createTask({ runId: other.id, spec: 'Other work' })
  f.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_helper',
    creator: { kind: 'terminal', handle: 'term_peer' },
    maxDepth: 10
  })
  let builds = 0
  const model = new CrewReadModel((previous) => {
    if (!previous) {
      builds++
    }
    return f.deps
  }, f.db.crewChanges.subscribe)
  const show = (party: string) =>
    subscribeCrew(
      () => model.read(party),
      (wake) => model.subscribe(wake, party),
      () => {}
    )
  const mounted = show('term_coord')
  show('term_peer')()
  model.read('term_coord')
  // The closed chat's crew starts another worker; the open chat's next read must not rebuild for it.
  const next = f.db.createTask({ runId: other.id, spec: 'More work' })
  f.db.createDispatchContext({
    taskId: next.id,
    assigneeHandle: 'term_outbound',
    creator: { kind: 'terminal', handle: 'term_peer' },
    maxDepth: 10
  })
  model.read('term_coord')
  expect(builds).toBe(1)
  mounted()
})
