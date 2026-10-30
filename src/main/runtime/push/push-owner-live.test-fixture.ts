import { launchOwnerCompanions } from './push-owner-companions.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createOwnerBridge,
  ownerCleanup,
  integrationDeadline as deadline
} from './push-owner-bridge.test-fixture'
import {
  desktopActors,
  settleOwnerDelivery,
  expectOwnerEnrollment,
  ownerCapacityPhase
} from './push-owner-desktop.test-fixture'
import {
  httpResult,
  record,
  text
} from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

it('keeps T2 through late/lost actual replies and recovers bounded source failures through real route/admission/provider settlement', async () => {
  const root = resolve('.')
  const scratch = mkdtempSync(join(tmpdir(), 'pr35901-owner-'))
  const bridge = createOwnerBridge()
  const base = await bridge.start()
  const abort = new AbortController()
  const closed = new Set<string>()
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const heldRoute = Promise.withResolvers<void>()
  const heldA = Promise.withResolvers<void>()
  const droppedA = Promise.withResolvers<void>()
  const refusalResponse = Promise.withResolvers<void>()
  const registrationCommit = Promise.withResolvers<void>()
  let refusalRace = false
  let rollover = false
  let aFirst = true
  let t1RouteHeld = false
  let accepted = 0
  let routeAttempts = 0
  const T1 = 'a'.repeat(64)
  const T2 = 'b'.repeat(64)
  const cloud = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('cloud', op, data), `cloud ${op}`)
  const mobile = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('mobile', op, data), `mobile ${op}`)
  const capacity = ownerCapacityPhase({ mobile, cloud, event: bridge.event, wait: bridge.wait })
  const gateway = async (value: Record<string, unknown>) => {
    if (text(value.url).endsWith('/v1/routes')) {
      routeAttempts++
    }
    await capacity.before(value)
    const result = await cloud('http', value)
    const response = httpResult(result)
    const url = text(value.url)
    if (
      url.endsWith('/v1/routes') &&
      response.ok &&
      record(JSON.parse(text(value.body))).action === 'replace'
    ) {
      expect(record(await response.clone().json()).status).toBe('accepted')
      const declaration = record(JSON.parse(text(value.body)))
      capacity.accepted(declaration)
      if (declaration.token === T1 && !t1RouteHeld) {
        t1RouteHeld = true
        bridge.event('T1 route committed')
        await heldRoute.promise
      } else {
        bridge.event(`accepted:${++accepted}`, declaration)
      }
    }
    if (url.endsWith('/v1/routes') && refusalRace && response.status === 403) {
      bridge.event('real route refusal')
      await refusalResponse.promise
    }
    if (url.endsWith('/v1/send')) {
      expect(response.ok).toBe(true)
      const notification = record(record(JSON.parse(text(value.body))).notification)
      bridge.event(`sent:${text(value.host)}:${text(notification.occurrence)}`)
    }
    return result
  }
  const actors = desktopActors(scratch, async (host, url, init) =>
    httpResult(
      await gateway({
        host,
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body === undefined ? {} : { body: String(init.body) })
      })
    )
  )
  bridge.route(async (path, value) => {
    if (path === '/gateway') {
      return gateway(value)
    }
    if (path !== '/rpc') {
      throw new Error(`Unexpected bridge path ${path}`)
    }
    if (refusalRace && value.method === 'notifications.registerPush') {
      await registrationCommit.promise
    }
    const result = await actors.rpc(value)
    const params = record(value.params ?? {})
    if (value.method === 'notifications.registerPush') {
      expect(record(result).registered).toBe(true)
      const host = text(value.host)
      const token = text(params.token)
      bridge.event(`${rollover ? 'committed' : 'first-committed'}:${host}:${token}`)
      if (host === 'A' && token === T1 && aFirst) {
        aFirst = false
        await heldA.promise
      }
      if (rollover && host === 'A' && token === T2) {
        await droppedA.promise
      }
    }
    return result
  })
  const launches = launchOwnerCompanions(root, base, abort, closed)
  const resultsPromise = Promise.allSettled(launches)
  let primary: { failed: true; error: unknown } | undefined
  const advance = async (delta: number) => {
    clock += delta
    await cloud('advance', { delta })
    return mobile('advance', { delta })
  }
  const settle = (label: string, expected: number) =>
    settleOwnerDelivery(
      {
        actors,
        cloud,
        advance,
        sent: (occurrence) =>
          deadline(
            Promise.all(['A', 'B'].map((host) => bridge.wait(`sent:${host}:${occurrence}`))),
            'actual desktop sends'
          )
      },
      label,
      expected,
      T2
    )
  try {
    await deadline(
      Promise.all([bridge.ready('cloud'), bridge.ready('mobile')]),
      'actors ready',
      45_000
    )
    const initial = record(await mobile('start', { profiles: actors.profiles }))
    expect(initial.keyReads).toBe(1)
    expect(initial.keyWrites).toBe(0)
    const joined = record(await mobile('attach'))
    expect(joined.preparations).toBe(2)
    expect(joined.keyReads).toBe(1)
    expect(joined.keyWrites).toBe(0)
    expect(routeAttempts).toBe(0)
    expect(actors.registered()).toEqual([{}, {}])
    const retired = record(await mobile('retire-first-use'))
    expect(retired.retired).toBe(4)
    expect(retired.preparations).toBe(6)
    expect(retired.preparationState).toMatchObject({ keyTask: 1, keyEntries: 3, creator: 0 })
    expect(routeAttempts).toBe(0)
    expect(actors.registered()).toEqual([{}, {}])
    await mobile('release-key')
    await deadline(
      Promise.all(['A', 'B'].map((host) => bridge.wait(`first-committed:${host}:${T2}`))),
      'first-use keyed registrations'
    )
    await deadline(
      Promise.all(['A', 'B'].map((host) => bridge.wait(`first-observed:${host}:${T2}`))),
      'first-use acknowledgements consumed'
    )
    await mobile('drain')
    const firstDeclaration = record(
      await deadline(bridge.wait('accepted:1'), 'unseeded signed declaration')
    )
    const created = record(await mobile('stats'))
    expect(created.keyReads).toBe(2)
    expect(created.keyWrites).toBe(1)
    expect(created.metadataReads).toBe(1)
    expect(created.metadataWrites).toBe(0)
    expect(firstDeclaration).toMatchObject({ token: T2, routeKey: created.routeKey })
    expect(firstDeclaration.hosts).toEqual(actors.fingerprints)
    const firstState = await settle('first-use-current-creators', 1)
    expectOwnerEnrollment(firstState, T2, created.routeKey)
    rollover = true
    await mobile('begin-rollover')
    await deadline(bridge.wait(`committed:B:${T1}`), 'B T1 registration')
    await advance(1000)
    await deadline(bridge.wait('T1 route committed'), 'real signed T1 route')
    await deadline(bridge.wait(`committed:A:${T1}`), 'delayed A T1 registration')
    await mobile('token', { token: T2 })
    await deadline(bridge.wait(`observed:B:${T2}`), 'B T2 real success consumed')
    await mobile('drain')
    heldA.resolve()
    await deadline(bridge.wait(`committed:A:${T2}`), 'A T2 committed with lost reply')
    await advance(5000)
    heldRoute.resolve()
    const declaration = record(
      await deadline(bridge.wait('accepted:2'), 'actual current T2 declaration')
    )
    expect(declaration.token).toBe(T2)
    expect(declaration.hosts).toHaveLength(2)
    const state = await settle('g4-current-owner', 2)
    expectOwnerEnrollment(state, T2, declaration.routeKey)
    expect(actors.registered()).toHaveLength(2)
    droppedA.resolve()
    await actors.rpc({ host: 'A', method: 'notifications.unregisterPush' })
    await actors.rpc({ host: 'B', method: 'notifications.unregisterPush' })
    refusalRace = true
    const priorRefusal = accepted
    await mobile('foreground')
    await deadline(bridge.wait('real route refusal'), 'actual live-registration route refusal')
    registrationCommit.resolve()
    await deadline(bridge.wait('renewed:B'), 'current registration wake racing refusal')
    await mobile('drain')
    refusalResponse.resolve()
    await advance(1)
    await deadline(bridge.wait(`accepted:${priorRefusal + 1}`), 'real refusal wake accepted')
    refusalRace = false
    await settle('refusal-racing-registration', 3)
    await mobile('disconnect')
    for (const [index, kind] of [
      'catalog-read',
      'non-array',
      'version-read',
      'version-write',
      'catalog-race'
    ].entries()) {
      await mobile('fault', { kind })
      await mobile('background')
      await advance(5000)
      await advance(5000)
      const parked = record(await mobile('stats'))
      expect(parked.reads).toBe(3)
      const posts = accepted
      const attempted = routeAttempts
      await advance(60 * 60_000)
      expect(record(await mobile('stats')).reads).toBe(3)
      expect(accepted).toBe(posts)
      expect(routeAttempts).toBe(attempted)
      await mobile('repair')
      if (kind === 'catalog-race') {
        await mobile('release-failure')
      }
      const restored = record(
        await deadline(bridge.wait(`accepted:${posts + 1}`), `real repair ${kind}`)
      )
      expect(restored.token).toBe(T2)
      await settle(`g5-recovered-${index}`, index + 4)
    }
    const prior = accepted
    await mobile('restart')
    await deadline(bridge.wait(`accepted:${prior + 1}`), 'saved-state disconnected restart')
    await capacity.run(actors.fingerprints)
    await settle('cap-retained-provider', 9)
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => capacity.release())
  for (const barrier of [heldA, heldRoute, droppedA, refusalResponse, registrationCommit]) {
    await cleanup.run(() => barrier.resolve())
  }
  await cleanup.run(() => actors.stop())
  for (const stop of [() => mobile('stop'), () => cloud('stop')]) {
    await cleanup.run(stop)
  }
  if (cleanup.failed) {
    await cleanup.run(() => abort.abort())
  }
  const results = await resultsPromise
  for (const result of results) {
    await cleanup.run(() => {
      if (result.status === 'rejected') {
        throw result.reason
      }
      expect(result.value.code).toBe(0)
    })
  }
  await cleanup.run(() => bridge.close())
  await cleanup.run(() => vi.restoreAllMocks())
  await cleanup.run(() => {
    if (closed.size !== 2) {
      throw new Error(`Owned companion closure unverified; retained ${scratch}`)
    }
    rmSync(scratch, { recursive: true, force: true })
  })
  cleanup.finish()
}, 180_000)
