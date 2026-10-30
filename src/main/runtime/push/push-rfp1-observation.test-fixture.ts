import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { deriveRelayHostId } from '../mobile-cloud-relay/relay-http-client'
import { expect, vi } from 'vitest'
import {
  createOwnerBridge,
  integrationDeadline as deadline,
  integrationRows as rows,
  ownerCleanup
} from './push-owner-bridge.test-fixture'
import { launchOwnerCompanions } from './push-owner-companions.test-fixture'
import {
  observationRuntime,
  RFP1_A,
  RFP1_OLD,
  RFP1_WORKSPACE
} from './push-rfp1-source-runtime.test-fixture'
import { observationNativePorts, observationRenderer } from './push-rfp1-renderer.test-fixture'
import { observationRelay } from './push-rfp1-relay.test-fixture'
import {
  headers,
  httpResult,
  record,
  text
} from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

type Actor = Awaited<ReturnType<typeof observationRuntime>>
function redacted(value: unknown): unknown {
  const credentials = new Set<string>()
  const sensitive = /token|authorization|credential|secret|pairingUrl/i
  const collect = (input: unknown): void => {
    if (typeof input === 'string') {
      try {
        collect(JSON.parse(input))
      } catch {
        /* Raw non-JSON strings have no child fields. */
      }
    } else if (Array.isArray(input)) {
      input.forEach(collect)
    } else if (typeof input === 'object' && input !== null) {
      for (const [key, child] of Object.entries(input)) {
        if (sensitive.test(key) && typeof child === 'string' && child.length > 8) {
          credentials.add(child)
          if (child.startsWith('Bearer ')) {
            credentials.add(child.slice(7))
          }
        }
        collect(child)
      }
    }
  }
  collect(value)
  const sanitize = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let result = input
      for (const credential of credentials) {
        result = result.split(credential).join('<generated-redacted>')
      }
      return result
        .replace(/Bearer [^\s"',}]+/gi, 'Bearer <generated-redacted>')
        .replace(/([ab])\1{63}/g, '<generated-device-token>')
    }
    if (Array.isArray(input)) {
      return input.map(sanitize)
    }
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [
          key,
          sensitive.test(key) ? '<generated-redacted>' : sanitize(child)
        ])
      )
    }
    return input
  }
  return sanitize(value)
}

export async function runRfp1Observation() {
  const captureRoot = resolve(
    process.env.ORCA_PUSH_OWNER_CAPTURE_DIR ?? 'test-results/pr35901-rfp1'
  )
  mkdirSync(captureRoot, { recursive: true })
  const cacheRoot = resolve(import.meta.dirname, '../../../../tests/e2e/.cross-version-checkouts')
  mkdirSync(cacheRoot, { recursive: true })
  const scratch = mkdtempSync(join(cacheRoot, 'pr35901-rfp1-'))
  const native = observationNativePorts(scratch)
  const bridge = createOwnerBridge()
  let base = ''
  const abort = new AbortController()
  const closed = new Set<string>()
  const cloud = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('cloud', op, data), `observation cloud ${op}`)
  const mobile = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('mobile', op, data), `observation phone ${op}`)
  let leg = 'old-C'
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const captures: unknown[] = []
  const httpTasks: Promise<Response>[] = []
  const observations: Record<string, unknown>[] = []
  const capture = (value: Record<string, unknown>) => {
    captures.push({ leg, ...value })
  }
  let removalPending = false
  let holdC = Promise.withResolvers<void>()
  let replacement = Promise.withResolvers<void>()
  let sends: string[] = []
  let sendAttempts: string[] = []
  let ownerHead: string | undefined
  const performGateway: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = request.url
    const body = await request.text()
    const parsed = body ? record(JSON.parse(body)) : {}
    if (url.endsWith('/v1/routes') && parsed.action === 'replace' && removalPending) {
      capture({ boundary: 'replacement-before-gateway-commit', declaration: parsed })
      bridge.event(`replacement-pending:${leg}`)
      await replacement.promise
    }
    const response = httpResult(
      await cloud('http', {
        url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        ...(body ? { body } : {})
      })
    )
    capture({
      boundary: 'actual-signed-HTTP',
      url,
      method: request.method,
      body: parsed,
      status: response.status
    })
    if (
      url.endsWith('/v1/routes') &&
      parsed.action === 'replace' &&
      response.ok &&
      !removalPending
    ) {
      expect(record(await response.clone().json()).status).toBe('accepted')
      bridge.event(`initial-route:${leg}`, parsed)
    }
    return response
  }
  const gateway: typeof fetch = (input, init) => {
    const work = performGateway(input, init)
    httpTasks.push(work)
    void work.catch(() => {})
    return work
  }
  const actorFetch =
    (id: string): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init)
      if (request.url.endsWith('/v1/send')) {
        sendAttempts.push(id)
      }
      if (request.url.endsWith('/v1/send') && id === 'C') {
        await holdC.promise
      }
      const response = await gateway(request)
      if (request.url.endsWith('/v1/send')) {
        expect(response.ok).toBe(true)
        sends.push(id)
        bridge.event(`send:${leg}:${id}`)
      }
      return response
    }
  bridge.route(async (path, value) => {
    if (path === '/gateway') {
      return gateway(text(value.url), {
        method: text(value.method),
        headers: headers(value.headers),
        ...(value.body ? { body: text(value.body) } : {})
      }).then(async (r) => ({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: await r.text()
      }))
    }
    if (path === '/observation') {
      capture(value)
      if (value.boundary === 'phone-held-status-settled') {
        bridge.event('held-status-settled', value)
      }
      return null
    }
    throw new Error(`Unexpected observation bridge path ${path}`)
  })
  let resultsPromise: Promise<
    PromiseSettledResult<Awaited<ReturnType<typeof launchOwnerCompanions>[number]>>[]
  > = Promise.resolve([])
  const actors: Actor[] = []
  const renderers: Awaited<ReturnType<typeof observationRenderer>>[] = []
  const relays: Awaited<ReturnType<typeof observationRelay>>[] = []
  let primary: { failed: true; error: unknown } | undefined
  const start = async (id: string, pin: string, path: string, port?: number) => {
    const profile = join(path, id, 'profile')
    const actor = await native.run(profile, () =>
      observationRuntime({ scratch: path, id, pin, port, fetch: actorFetch(id), capture })
    )
    actors.push(actor)
    capture({
      boundary: 'materialized-actor',
      actor: id,
      pin: actor.checkout.commit,
      runtimeId: actor.runtime.getRuntimeId()
    })
    return actor
  }
  const drainProvider = async () => {
    await cloud('flush')
    clock += 1000
    await cloud('advance', { delta: 1000 })
    await mobile('advance', { delta: 1000 })
    await cloud('flush')
    return record(await cloud('snapshot'))
  }
  const closeLeg = async () => {
    const cleanup = ownerCleanup()
    await cleanup.run(() => mobile('end-leg'))
    for (const relay of relays) {
      await cleanup.run(() => relay.release())
    }
    for (const renderer of renderers.toReversed()) {
      await cleanup.run(() => renderer.close())
    }
    for (const actor of actors.toReversed()) {
      await cleanup.run(() => actor.close())
    }
    for (const relay of relays) {
      await cleanup.run(() => relay.close())
    }
    for (const work of httpTasks) {
      await cleanup.run(() => work)
    }
    renderers.length = 0
    actors.length = 0
    relays.length = 0
    httpTasks.length = 0
    cleanup.finish()
  }
  const currentStatus = (frame: unknown, actor: Actor, descriptorUnavailable = false) => {
    const response = record(frame)
    expect(response.ok).toBe(true)
    expect(record(response.result).runtimeId).toBe(actor.runtime.getRuntimeId())
    expect(record(response._meta).runtimeId).toBe(actor.runtime.getRuntimeId())
    if (descriptorUnavailable) {
      expect(record(response.result).hostDescriptor).toBeUndefined()
    }
    return response
  }
  try {
    ownerHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    capture({ boundary: 'current-owner-source-pin', ownerHead })
    base = await bridge.start()
    resultsPromise = Promise.allSettled(
      launchOwnerCompanions(resolve('.'), base, abort, closed, true)
    )
    await deadline(
      Promise.all([bridge.ready('cloud'), bridge.ready('mobile')]),
      'observation companions ready',
      45_000
    )
    for (const capable of [false, true]) {
      leg = capable ? 'capable-C' : 'old-C'
      const path = join(scratch, leg)
      holdC = Promise.withResolvers<void>()
      replacement = Promise.withResolvers<void>()
      removalPending = false
      sends = []
      sendAttempts = []
      const B = await start('B', RFP1_OLD, path)
      const A = await start('A', RFP1_A, path)
      const C = await start('C', capable ? RFP1_A : RFP1_OLD, path)
      const aRelay = await observationRelay(A, native, capture)
      relays.push(aRelay)
      const cRelay = await observationRelay(C, native, capture)
      relays.push(cRelay)
      const RA = aRelay.pair(B)
      const RC = cRelay.pair(B)
      const aView = await observationRenderer(A, RA.id, native, capture)
      renderers.push(aView)
      const cView = await observationRenderer(C, RC.id, native, capture)
      renderers.push(cView)
      const prior = record(await cloud('snapshot'))
      await mobile('pair', {
        leg,
        offers: {
          A: A.offer('mobile', 'Phone'),
          B: B.offer('mobile', 'Phone'),
          C: C.offer('mobile', 'Phone')
        }
      })
      await deadline(bridge.wait(`initial-route:${leg}`), 'real initial signed membership')
      await deadline(
        Promise.all(['A', 'B', 'C'].map((id) => bridge.wait(`phone-registered:${leg}:${id}`))),
        'actual keyed or legacy enrollments consumed'
      )
      await mobile('select', { environmentId: RC.id, archiveRoot: C.checkout.root })
      const initialA = currentStatus(await aView.status(), B)
      capture({ boundary: 'A-authenticated-source-status', frame: initialA })
      const sourceProjection = record(await aView.projection())
      expect(sourceProjection.ok).toBe(true)
      capture({ boundary: 'A-authenticated-source-session-projection', frame: sourceProjection })
      capture({
        boundary: 'initial-phone-view',
        sample: await mobile('sample', { workspace: RFP1_WORKSPACE })
      })
      removalPending = true
      clock++
      await mobile('advance', { delta: 1 })
      await mobile('remove-A')
      await deadline(
        bridge.wait(`replacement-pending:${leg}`),
        'post-removal declaration held before commit'
      )
      // Await actual subscribed source selection before committing new journal work.
      await deadline(B.subscribed, 'real renderer source feeds ready')
      const cursor = await B.commit(`observed-${leg}`)
      capture({ boundary: 'actual-B-journal-commit', pin: RFP1_OLD, cursor })
      await deadline(bridge.wait(`send:${leg}:A`), 'source-produced A send')
      const queued = await drainProvider()
      const provider = rows(queued.providers).at(-1)
      if (!provider || rows(queued.providers).length !== rows(prior.providers).length + 1) {
        throw new Error('Expected one source-produced A provider payload')
      }
      const payload = record(JSON.parse(text(provider.body)))
      const alert = record(payload.orca)
      expect(alert.origin).toBe(deriveRelayHostId(B.keypair.publicKey))
      expect(alert.hostFingerprint).toBe(deriveRelayHostId(A.keypair.publicKey))
      expect(typeof alert.notificationId).toBe('string')
      expect(rows(queued.claims).filter((claim) => claim.state === 'sent')).toHaveLength(
        rows(prior.claims).length + 1
      )
      expect(alert).not.toHaveProperty('runtimeId')
      expect(alert).not.toHaveProperty('hostDescriptor')
      capture({
        boundary: 'queued-source-payload-facts',
        alert,
        sourceRuntimeId: B.runtime.getRuntimeId(),
        sourceCursor: cursor,
        sourcePin: B.checkout.commit
      })
      const V = record(await mobile('present', { payload, workspace: RFP1_WORKSPACE, case: 'E1' }))
      const U = record(
        await mobile('present', { payload, workspace: 'observation::/observation/w2', case: 'E2' })
      )
      expect(record(U.behavior).shouldShowBanner).toBe(true)
      capture({
        boundary: 'V-U-observation',
        V,
        U,
        requirement: 'V quiet; U alert',
        featureVerdict:
          record(V.behavior).shouldShowBanner === false
            ? 'initial pair meets viewing requirement; full coverage UNRUN'
            : 'OPEN: observed V does not meet quiet requirement'
      })
      holdC.resolve()
      await deadline(bridge.wait(`send:${leg}:C`), 'real independently eligible C send')
      const settled = await drainProvider()
      expect(rows(settled.pending)).toEqual([])
      expect(sendAttempts.filter((id) => id === 'B')).toEqual([])
      expect(sends.filter((id) => id === 'B')).toEqual([])
      if (capable) {
        expect(rows(settled.providers)).toHaveLength(rows(prior.providers).length + 1)
        expect(settled.decisions).toContain('superseded')
      } else {
        expect(rows(settled.providers)).toHaveLength(rows(prior.providers).length + 2)
        const legacyProvider = rows(settled.providers).at(-1)
        if (!legacyProvider) {
          throw new Error('Missing old C actual markerless provider body')
        }
        const legacy = record(JSON.parse(text(legacyProvider.body)))
        expect(record(legacy.orca).origin).toBeUndefined()
        const oldV = record(
          await mobile('present', {
            payload: legacy,
            workspace: RFP1_WORKSPACE,
            case: 'E1-old-C-copy'
          })
        )
        const oldU = record(
          await mobile('present', {
            payload: legacy,
            workspace: 'observation::/observation/w2',
            case: 'E2-old-C-copy'
          })
        )
        expect(record(oldV.behavior).shouldShowBanner).toBe(false)
        expect(record(oldU.behavior).shouldShowBanner).toBe(true)
        capture({ boundary: 'old-C-real-markerless-presentation', V: oldV, U: oldU })
      }
      capture({ boundary: 'fenced-settlement', snapshot: settled })
      {
        const endpoint = B.server.getWebSocketEndpoint()
        if (!endpoint) {
          throw new Error('B has no actual restart endpoint')
        }
        const port = Number(new URL(endpoint).port)
        const before = B.runtime.getRuntimeId()
        await B.close()
        const restarted = await start('B', RFP1_OLD, path, port)
        expect(restarted.keypair.publicKey).toEqual(B.keypair.publicKey)
        expect(restarted.runtime.getRuntimeId()).not.toBe(before)
        const healthyA = currentStatus(await aView.status(), restarted)
        expect(record(record(healthyA.result).hostDescriptor).installationId).toBe(
          record(record(initialA.result).hostDescriptor).installationId
        )
        capture({ boundary: 'E8-healthy-restart-current-A', frame: healthyA })
        const healthyPhone = record(await mobile('sample', { workspace: RFP1_WORKSPACE }))
        currentStatus(healthyPhone.frame, restarted)
        capture({ boundary: 'E8-healthy-restart-current-phone', sample: healthyPhone })
        await restarted.close()
        const installation = join(restarted.profile, 'host-installation.json')
        renameSync(installation, `${installation}.healthy`)
        mkdirSync(installation)
        const unavailable = await start('B', RFP1_OLD, path, port)
        const currentA = currentStatus(await aView.status(), unavailable, true)
        const currentPhone = record(
          await mobile('sample', { workspace: RFP1_WORKSPACE, descriptorUnavailable: true })
        )
        currentStatus(currentPhone.frame, unavailable, true)
        capture({ boundary: 'E8-real-descriptor-read-failure-current-A', frame: currentA })
        capture({ boundary: 'E8-real-descriptor-read-failure-current-phone', sample: currentPhone })
        observations.push({
          case: 'E8',
          queuedPayload: alert,
          queuedRuntimeId: before,
          currentA,
          currentPhone,
          fact: 'Same saved B key; new process IDs; actual optional descriptor absent on both current paths. Queued provider body has neither process nor descriptor fields.',
          candidateJoin: 'UNSELECTED; these bytes do not prove universal impossibility'
        })
        capture({
          boundary: 'E8-original-queued-payload-presentation',
          result: await mobile('present', { payload, workspace: RFP1_WORKSPACE, case: 'E8' })
        })
        const D = await start('D', RFP1_OLD, path)
        const held = cRelay.holdStatus()
        await mobile('held-status')
        await deadline(held, 'E6 actual raw old B reply held')
        await cRelay.replace(RC.id, D)
        const retired = await deadline(
          bridge.wait('held-status-settled'),
          'real retired request outcome'
        )
        cRelay.release()
        const currentD = record(await mobile('sample', { workspace: RFP1_WORKSPACE }))
        currentStatus(currentD.frame, D)
        expect(record(record(currentD.frame).result).runtimeId).not.toBe(
          unavailable.runtime.getRuntimeId()
        )
        observations.push({
          case: 'E6',
          preRePairCatalog: currentPhone.catalog,
          retired,
          currentD,
          fact: 'Actual same-alias saved re-pair/invalidation; old request settles through the real tracker and current sample belongs to D.',
          candidateJoin: 'UNSELECTED; no cached alias made into authority'
        })
        capture({ boundary: 'E6-current-D-phone-view', sample: currentD })
        await unavailable.close()
        rmdirSync(installation)
        renameSync(`${installation}.healthy`, installation)
      }
      replacement.resolve()
      removalPending = false
      await closeLeg()
    }
    capture({
      boundary: 'finite-experiment-result',
      execution: 'completed-initial-cut',
      observationSufficiency:
        'HOLD-FOR-PANEL: initial observations only; no complete join selected or universal impossibility proved',
      observations,
      cases: {
        E1: 'captured-both-C-legs',
        E2: 'captured-both-C-legs',
        E6: 'captured',
        E8: 'captured',
        remaining: 'UNRUN; no full E1-E16 closure'
      },
      production: 'HELD'
    })
  } catch (error) {
    primary = { failed: true, error }
    capture({
      boundary: 'SETUP-OR-EXECUTION-FAILURE',
      error: String(error),
      observationSufficiency: 'UNRUN; not incompatibility proof'
    })
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => holdC.resolve())
  await cleanup.run(() => replacement.resolve())
  await cleanup.run(closeLeg)
  for (const action of [() => mobile('stop'), () => cloud('stop')]) {
    await cleanup.run(action)
  }
  if (cleanup.failed) {
    await cleanup.run(() => abort.abort())
  }
  for (const result of await resultsPromise) {
    await cleanup.run(() => {
      if (result.status === 'rejected') {
        throw result.reason
      }
      expect(result.value.code).toBe(0)
    })
  }
  await cleanup.run(() => bridge.close())
  await cleanup.run(() => native.close())
  await cleanup.run(() => vi.restoreAllMocks())
  await cleanup.run(() => vi.unstubAllGlobals())
  const raw = JSON.stringify(
    redacted({
      sourcePins: { old: RFP1_OLD, A: RFP1_A, owner: ownerHead },
      captures,
      cleanupFailed: cleanup.failed,
      coverage: {
        E1: primary ? 'see finite captures; no pass claim' : 'initial-cut both C legs',
        E2: primary ? 'see finite captures; no pass claim' : 'initial-cut both C legs',
        E6: primary ? 'see finite captures; no pass claim' : 'initial-cut',
        E8: primary ? 'see finite captures; no pass claim' : 'initial-cut',
        others: 'UNRUN',
        Android: 'UNRUN',
        completeObservationSufficiency: 'NOT ESTABLISHED'
      }
    }),
    null,
    2
  )
  const digest = createHash('sha256').update(raw).digest('hex')
  await cleanup.run(() => writeFileSync(join(captureRoot, `${digest}.json`), raw))
  console.log(
    `RFP1 finite capture ${digest}: ${primary ? 'execution FAIL, observation UNRUN' : 'execution complete, observation HOLD; production HELD'}; ${captureRoot}`
  )
  await cleanup.run(() => {
    if (closed.size !== 2) {
      throw new Error(`Companion closure unverified; retained ${scratch}`)
    }
    rmSync(scratch, { recursive: true, force: true })
  })
  cleanup.finish()
}
