import {
  AssignmentRequestSchema,
  isRelayCellConnectionHardCap,
  RELAY_ADMISSION_BUDGETS,
  RELAY_DEFAULT_REGION,
  RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND,
  RELAY_PROTOCOL_LIMITS,
  RelayRegionSchema,
  ResolveRequestSchema,
  cellPlacementCeiling,
  relayCellAdmissionBounds,
  type RelayCellConnectionHardCap,
  type RelayRegion
} from '@orca-cloud/relay-contract'
import { Hono, type Context } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import {
  createAdminTokenVerifier,
  createReadOnlyAdminTokenVerifier,
  createRegionalRehomeControlApplyTokenVerifier,
  createRegionalRehomeRuntimeTokenVerifier,
  createRegionalRehomeTokenVerifier,
  createRuntimeTokenVerifier
} from './admin-token-verifier.js'
import type {
  CellFenceAttemptEvidence,
  RelayAssignment,
  RelayAssignmentStore
} from './assignment-store.js'
import { AssignmentRejectionLogWindow } from './assignment-rejection-log-window.js'
import { CELL_ADMISSION_STATES } from './cell-admission-selector.js'
import { RELAY_MAX_CELL_CAPACITY_REQUESTS, type RelayConfig } from './config.js'
import type { RelayCredentialStore } from './credential-store.js'
import { isRelayDatabaseTransientError } from './database.js'
import { googleMetadataIdentityToken } from './google-metadata-identity-token.js'
import {
  RelayPublicAssignmentAdmission,
  type AssignmentAdmissionRejection
} from './public-assignment-admission.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RelayRuntimeCounts } from './relay-observability.js'
import {
  isRegionalRehomeTrustProbe,
  probeRegionalRehomeTrust
} from './regional-rehome-trust-probe.js'
import { createRelayTokenVerifier, readBearer } from './relay-token-verifier.js'
import { stagingAsiaProofMembership } from './staging-asia-proof-admission.js'

const RelayCellConnectionHardCapSchema = z.custom<RelayCellConnectionHardCap>(
  isRelayCellConnectionHardCap
)

const ASSIGNMENT_REJECTION_LOG_WINDOW_MS = 10_000
const REGION_CATALOG_CACHE_MS = 30_000

type AdmissionRejectionLogEntry = {
  route: 'assign' | 'resolve'
  lane: 'sticky' | 'placement'
  hinted: boolean
  relayHostId: string
  reason: AssignmentAdmissionRejection
}

export function createRelayApp(
  config: RelayConfig,
  operations: {
    store: RelayCredentialStore
    assignments: RelayAssignmentStore
    drain: (graceMs: number) => void
    drainHost?: (input: {
      attemptId: string
      userId: string
      relayHostId: string
      sourceAssignmentEpoch: number
      graceMs: number
    }) => 'accepted' | 'already-accepted' | 'host-not-connected'
    regionalRehomeIdentityToken?: (audience: string) => Promise<string>
    regionalRehomeFetch?: typeof fetch
    regionalRehomeTrustProbeHostExists?: (input: {
      userId: string
      relayHostId: string
    }) => boolean
    cellIncarnation?: string
    isDraining?: () => boolean
    runtimeCounts?: () => RelayRuntimeCounts
    ready: () => Promise<boolean>
    recordAssignmentAdmission?: (
      outcome: 'sticky' | 'sticky-rejected' | 'placement' | 'placement-rejected'
    ) => void
    recordAssignmentRejectionReason?: (
      lane: 'sticky' | 'placement',
      reason: AssignmentAdmissionRejection
    ) => void
    recordRegionRequest?: (region: RelayRegion | undefined) => void
    recordRegionSelection?: (input: {
      targetRegion: RelayRegion
      selectedRegion?: RelayRegion
      fallback: boolean
    }) => void
  }
): Hono {
  const app = new Hono()
  let regionCatalogCache:
    | { expiresAt: number; value: Awaited<ReturnType<RelayAssignmentStore['regionCatalog']>> }
    | undefined
  let regionCatalogRefresh:
    | Promise<Awaited<ReturnType<RelayAssignmentStore['regionCatalog']>>>
    | undefined
  const regionCatalog = async () => {
    const now = Date.now()
    if (regionCatalogCache && regionCatalogCache.expiresAt > now) {
      return regionCatalogCache.value
    }
    regionCatalogRefresh ??= operations.assignments.regionCatalog().then((value) => {
      regionCatalogCache = { expiresAt: Date.now() + REGION_CATALOG_CACHE_MS, value }
      return value
    })
    try {
      return await regionCatalogRefresh
    } finally {
      regionCatalogRefresh = undefined
    }
  }
  const verifyRelayToken = createRelayTokenVerifier(config)
  const verifyAdminToken = createAdminTokenVerifier(config)
  const verifyReadOnlyAdminToken = createReadOnlyAdminTokenVerifier(config)
  const verifyRegionalRehomeControlApplyToken =
    createRegionalRehomeControlApplyTokenVerifier(config)
  const verifyRuntimeToken = createRuntimeTokenVerifier(config)
  const verifyRegionalRehomeToken = createRegionalRehomeTokenVerifier(config)
  const verifyRegionalRehomeRuntimeToken =
    createRegionalRehomeRuntimeTokenVerifier(config)
  const regionalRehomeFetch = operations.regionalRehomeFetch ?? fetch
  const regionalRehomeIdentityToken =
    operations.regionalRehomeIdentityToken ??
    ((audience: string) => googleMetadataIdentityToken(audience, regionalRehomeFetch))
  const publicAssignmentAdmission = new RelayPublicAssignmentAdmission({
    maxConcurrent: config.publicAssignmentConcurrency,
    maxQueued: config.publicAssignmentQueueMax,
    waitMs: config.publicAssignmentWaitMs,
    maxReservedConcurrent: config.publicResolveConcurrency,
    reservedWaitMs: config.publicResolveWaitMs,
    minIntervalMs: config.publicAssignmentRetryAfterSeconds * 1_000,
    onRejected: (reason) => operations.recordAssignmentRejectionReason?.('placement', reason)
  })
  const rejectPublicAssignment = (context: Context): Response => {
    context.header('Retry-After', String(config.publicAssignmentRetryAfterSeconds))
    return context.json({ error: 'assignments_temporarily_unavailable' }, 503)
  }
  // Reconnecting hosts declare themselves and are verified against the durable
  // assignment inside this bounded lane, so a placement backlog can never
  // starve session recovery. Unhinted traffic never touches this lane.
  const stickyRetryAfterSeconds = config.publicStickyRetryAfterSeconds ?? 2
  const stickyAssignmentAdmission = new RelayPublicAssignmentAdmission({
    maxConcurrent: config.publicStickyConcurrency ?? 1,
    maxQueued: config.publicStickyQueueMax ?? 64,
    waitMs: config.publicStickyWaitMs ?? 2_000,
    minIntervalMs: stickyRetryAfterSeconds * 1_000,
    onRejected: (reason) => operations.recordAssignmentRejectionReason?.('sticky', reason)
  })
  const rejectStickyAssignment = (context: Context): Response => {
    context.header('Retry-After', String(stickyRetryAfterSeconds))
    return context.json({ error: 'assignments_temporarily_unavailable' }, 503)
  }
  // Aggregate counters cannot separate a handful of pathological hosts from a broad
  // population, so every admission rejection names its host and reason. Keyed on
  // route:lane:reason rather than host, the log stays bounded under load.
  const rejectionLogWindow = new AssignmentRejectionLogWindow<AdmissionRejectionLogEntry>({
    windowMs: ASSIGNMENT_REJECTION_LOG_WINDOW_MS,
    onWindowClosed: ({ suppressed, sample }) => logAssignmentRejection({ ...sample, suppressed })
  })
  const logAdmissionRejection = (input: {
    route: 'assign' | 'resolve'
    lane: 'sticky' | 'placement'
    hinted: boolean
    relayHostId: string
    reason: AssignmentAdmissionRejection | undefined
  }): void => {
    if (!input.reason) return
    const entry: AdmissionRejectionLogEntry = { ...input, reason: input.reason }
    if (!rejectionLogWindow.admit(`${entry.route}:${entry.lane}:${entry.reason}`, entry)) return
    logAssignmentRejection(entry)
  }
  app.use('/v1/admin/*', async (context, next) => {
    if (
      context.req.path === '/v1/admin/cell-heartbeat' ||
      context.req.path === '/v1/admin/cell-rehome-status'
    ) {
      return await next()
    }
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyAdminToken(bearer))) return await next()
    if (!(await verifyAdminToken(bearer, context.req.path))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    return await next()
  })

  // Not /healthz: Google Front End reserves that path before the container.
  app.get('/health', (context) =>
    context.json({ ok: true, connectionCapacityProtocol: 2 })
  )
  app.get('/ready', async (context) =>
    (await operations.ready())
      ? context.json({ ok: true })
      : context.json({ error: 'dependency_unavailable' }, 503)
  )
  app.get('/v1/regions', async (context) => {
    if (config.role === 'cell') return context.json({ error: 'director_only' }, 404)
    return context.json({ v: 1, regions: await regionCatalog() })
  })
  app.post('/v1/assign', async (context) => {
    if (config.role === 'cell') return context.json({ error: 'director_only' }, 404)
    if (!config.publicAssignmentsEnabled) return rejectPublicAssignment(context)
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer) return context.json({ error: 'invalid_token' }, 401)
    const claims = await verifyRelayToken(bearer)
    if (!claims) return context.json({ error: 'invalid_token' }, 401)
    if (Number(context.req.header('content-length') ?? 0) > 4 * 1024) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AssignmentRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (body.data.relayHostId !== claims.relayHostId) {
      return context.json({ error: 'host_identity_mismatch' }, 403)
    }
    const identity = { userId: claims.sub, relayHostId: claims.relayHostId }
    const requestedRegion = body.data.preferredRegion
    const targetRegion =
      config.regionalPlacementEnabled !== false && requestedRegion
        ? requestedRegion
        : RELAY_DEFAULT_REGION
    operations.recordRegionRequest?.(requestedRegion)
    let admission: { release(): void } | null = null
    let lane: 'sticky' | 'placement' = 'placement'
    if (body.data.reconnect) {
      let rejection: AssignmentAdmissionRejection | undefined
      const fastLane = await stickyAssignmentAdmission.acquire(claims.relayHostId, (reason) => {
        rejection = reason
      })
      if (!fastLane) {
        operations.recordAssignmentAdmission?.('sticky-rejected')
        logAdmissionRejection({
          route: 'assign',
          lane: 'sticky',
          hinted: true,
          relayHostId: claims.relayHostId,
          reason: rejection
        })
        return rejectStickyAssignment(context)
      }
      let verified = false
      try {
        verified = (await operations.assignments.resolve(identity)) !== null
      } catch (error) {
        fastLane.release()
        operations.recordAssignmentAdmission?.('sticky-rejected')
        if (isRelayDatabaseTransientError(error)) {
          logAssignmentRejection({
            route: 'assign-verify',
            lane: 'none',
            hinted: true,
            relayHostId: claims.relayHostId,
            reason: operationError(error)
          })
          return rejectStickyAssignment(context)
        }
        throw error
      }
      if (verified) {
        lane = 'sticky'
        admission = fastLane
        operations.recordAssignmentAdmission?.('sticky')
      } else {
        // An unverified hint joins the placement lane with today's semantics.
        fastLane.release()
      }
    }
    if (!admission) {
      let rejection: AssignmentAdmissionRejection | undefined
      admission = await publicAssignmentAdmission.acquire(claims.relayHostId, (reason) => {
        rejection = reason
      })
      operations.recordAssignmentAdmission?.(admission ? 'placement' : 'placement-rejected')
      if (!admission) {
        logAdmissionRejection({
          route: 'assign',
          lane: 'placement',
          hinted: Boolean(body.data.reconnect),
          relayHostId: claims.relayHostId,
          reason: rejection
        })
        return rejectPublicAssignment(context)
      }
    }
    let assignment: RelayAssignment
    try {
      assignment = requestedRegion
        ? await operations.assignments.assign(identity, requestedRegion, targetRegion)
        : await operations.assignments.assign(identity)
    } catch (error) {
      if (isRelayAssignmentCapacityError(error) || isRelayDatabaseTransientError(error)) {
        logAssignmentRejection({
          route: 'assign',
          lane,
          hinted: Boolean(body.data.reconnect),
          relayHostId: claims.relayHostId,
          reason: operationError(error)
        })
      }
      if (isRelayAssignmentCapacityError(error)) {
        if (lane === 'placement') {
          operations.recordRegionSelection?.({ targetRegion, fallback: false })
        }
        return context.json({ error: operationError(error) }, 503)
      }
      if (isRelayDatabaseTransientError(error)) {
        return lane === 'sticky' ? rejectStickyAssignment(context) : rejectPublicAssignment(context)
      }
      throw error
    } finally {
      admission.release()
    }
    operations.recordRegionSelection?.({
      targetRegion,
      selectedRegion: assignment.region,
      fallback: lane === 'placement' && assignment.region !== targetRegion
    })
    // Grant-side counterpart of the rejection log: reconnect grants are rare
    // enough to log and make "which cell is this host on" answerable.
    if (lane === 'sticky') {
      console.warn(
        `[orca-relay] assignment granted lane=sticky host=${relayHostLogDigest(claims.relayHostId)}` +
          ` cell=${assignment.cellId}`
      )
    }
    const lease = await new SignJWT({
      purpose: 'cell-assignment',
      cellId: assignment.cellId,
      cellUrl: assignment.cellUrl,
      assignmentEpoch: assignment.assignmentEpoch,
      relayHostId: claims.relayHostId
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(config.publicUrl)
      .setAudience('orca-relay-cell')
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(config.assignmentSigningKey)
    return context.json({
      v: 1,
      cellUrl: assignment.cellUrl,
      assignmentEpoch: assignment.assignmentEpoch,
      lease
    })
  })
  app.post('/v1/resolve', async (context) => {
    if (config.role === 'cell') return context.json({ error: 'director_only' }, 404)
    if (!config.publicAssignmentsEnabled) return rejectPublicAssignment(context)
    if (Number(context.req.header('content-length') ?? 0) > RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = ResolveRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    let rejection: AssignmentAdmissionRejection | undefined
    const admission = await publicAssignmentAdmission.acquireReserved(
      body.data.relayHostId,
      (reason) => {
        rejection = reason
      }
    )
    if (!admission) {
      logAdmissionRejection({
        route: 'resolve',
        lane: 'placement',
        hinted: false,
        relayHostId: body.data.relayHostId,
        reason: rejection
      })
      return rejectPublicAssignment(context)
    }
    try {
      const resolved = await operations.store.resolveResume(
        body.data.relayHostId,
        body.data.resumeToken
      )
      if (!resolved) return context.json({ error: 'invalid_credential' }, 401)
      const identity = {
        userId: resolved.userId,
        relayHostId: body.data.relayHostId
      }
      // This also migrates credentials created by the staging-only combined service.
      const assignment =
        (await operations.assignments.resolve(identity)) ??
        (await operations.assignments.assign(identity))
      return context.json({
        v: 1,
        cellUrl: assignment.cellUrl,
        assignmentEpoch: assignment.assignmentEpoch,
        leaseExpiresAt: assignment.leaseExpiresAt
      })
    } catch (error) {
      if (isRelayAssignmentCapacityError(error) || isRelayDatabaseTransientError(error)) {
        logAssignmentRejection({
          route: 'resolve',
          lane: 'none',
          hinted: false,
          relayHostId: body.data.relayHostId,
          reason: operationError(error)
        })
      }
      if (isRelayAssignmentCapacityError(error)) {
        return context.json({ error: operationError(error) }, 503)
      }
      if (isRelayDatabaseTransientError(error)) return rejectPublicAssignment(context)
      throw error
    } finally {
      admission.release()
    }
  })
  app.post('/v1/admin/drain', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    const body = z
      .object({ v: z.literal(1), graceMs: z.number().int().nonnegative().max(60 * 60 * 1000) })
      .strict()
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    operations.drain(body.data.graceMs)
    return context.json({ ok: true })
  })
  app.post('/v1/admin/host-drain', async (context) => {
    if (config.role !== 'cell' || !operations.drainHost) {
      return context.json({ error: 'cell_only' }, 404)
    }
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyRegionalRehomeToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = RegionalHostDrainSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (
      body.data.sourceCellId !== config.cellId ||
      !operations.cellIncarnation ||
      body.data.sourceCellIncarnation !== operations.cellIncarnation
    ) {
      return context.json({ error: 'regional_rehome_source_generation_mismatch' }, 409)
    }
    try {
      const trustProbe = isRegionalRehomeTrustProbe(body.data)
      let sharedRuntimeIdentityRejected: true | undefined
      if (trustProbe) {
        const runtimeToken = await regionalRehomeIdentityToken(config.rehomeAudience!)
        if (
          !(await verifyRegionalRehomeRuntimeToken(runtimeToken)) ||
          (await verifyRegionalRehomeToken(runtimeToken))
        ) {
          throw new Error('regional_rehome_shared_runtime_rejection_not_proven')
        }
        if (
          !operations.regionalRehomeTrustProbeHostExists ||
          operations.regionalRehomeTrustProbeHostExists(body.data)
        ) {
          throw new Error('regional_rehome_trust_probe_host_not_absent')
        }
        sharedRuntimeIdentityRejected = true
      }
      const outcome = operations.drainHost(body.data)
      return context.json({
        v: 1,
        outcome,
        ...(sharedRuntimeIdentityRejected ? { sharedRuntimeIdentityRejected } : {})
      })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/runtime-status', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = RuntimeStatusSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    return context.json({
      v: 1,
      role: config.role,
      cellId: config.cellId,
      cellUrl: config.cellUrl,
      region: config.region ?? RELAY_DEFAULT_REGION,
      imageDigest: config.imageDigest ?? null,
      draining: operations.isDraining?.() ?? false,
      regionalRehomeProtocol:
        config.rehomeAudience && config.rehomeDirectorServiceAccount ? 1 : 0,
      connectionCapacity:
        config.connectionHardCap === undefined
          ? null
          : {
              hardCap: config.connectionHardCap,
              controlRebindReserve: RELAY_ADMISSION_BUDGETS.reservedHostControls,
              ordinaryConnectionLimit: relayCellAdmissionBounds(config.connectionHardCap)
                .socketAdmissionCeiling,
              unobservedBound: config.connectionUnobservedBound!,
              normalAdmissionPause: cellPlacementCeiling(
                config.connectionHardCap,
                config.connectionUnobservedBound!
              )
            },
      runtime: operations.runtimeCounts?.() ?? null
    })
  })
  app.post('/v1/admin/cell-heartbeat', async (context) => {
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyRuntimeToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = CellHeartbeatSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.recordCellHeartbeat(body.data)
      return context.json({ ok: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-rehome-status', async (context) => {
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyRuntimeToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = CellRegionalRehomeStatusSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.recordCellRegionalRehomeStatus(body.data)
      return context.json({ ok: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/regional-rehome-control', async (context) => {
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyAdminToken(bearer, context.req.path))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = RegionalRehomeControlSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (body.data.action === 'inspect') {
      const control = await operations.assignments.inspectRegionalRehomeControl()
      return context.json({ v: 1, control })
    }
    if (!(await verifyRegionalRehomeControlApplyToken(bearer))) {
      return context.json({ error: 'insufficient_permission' }, 403)
    }
    try {
      const control = await operations.assignments.applyRegionalRehomeControl(body.data)
      return context.json({ v: 1, control })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/regional-rehome-trust-probe', async (context) => {
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await verifyAdminToken(bearer, context.req.path))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = RegionalRehomeTrustProbeSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (!config.rehomeAudience || !config.rehomeDirectorServiceAccount) {
      return context.json({ error: 'regional_rehome_trust_not_configured' }, 409)
    }
    try {
      const source = await operations.assignments.cellDeploymentStatus(
        body.data.sourceCellId
      )
      if (
        source.region !== RELAY_DEFAULT_REGION ||
        !source.runtime ||
        source.runtime.cellIncarnation !== body.data.sourceCellIncarnation ||
        !source.runtime.ready ||
        !source.runtime.heartbeatFresh ||
        source.runtime.regionalRehomeProtocol < 1
      ) {
        throw new Error('regional_rehome_trust_probe_source_unavailable')
      }
      const result = await probeRegionalRehomeTrust({
        sourceCellUrl: source.cellUrl,
        sourceCellId: body.data.sourceCellId,
        sourceCellIncarnation: body.data.sourceCellIncarnation,
        audience: config.rehomeAudience,
        identityToken: regionalRehomeIdentityToken,
        fetch: regionalRehomeFetch
      })
      return context.json(result)
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/evacuate', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminAssignmentMoveSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const migration = await operations.assignments.startEvacuation(
        { userId: body.data.userId, relayHostId: body.data.relayHostId },
        body.data.targetCellId
      )
      return context.json({ v: 1, migration })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/migration-complete', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminMigrationCompleteSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.completeEvacuation(
        { userId: body.data.userId, relayHostId: body.data.relayHostId },
        body.data.assignmentEpoch
      )
      return context.json({ ok: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/migration-supersede-cell', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminRegisteredCellMigrationSupersedeSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const superseded = await operations.assignments.supersedeRegisteredCellEvacuations(
        body.data.sourceCellId,
        body.data.currentTargetCellId,
        body.data.replacementTargetCellId,
        body.data.limit
      )
      return context.json({ v: 1, superseded })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/rebalance-dormant', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminAssignmentMoveSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const assignment = await operations.assignments.rebalanceDormant(
        { userId: body.data.userId, relayHostId: body.data.relayHostId },
        body.data.targetCellId
      )
      return context.json({ v: 1, assignment })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/admission-selector/apply', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminAdmissionSelectorApplySchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await operations.assignments.applyCellAdmissionSelector(body.data)
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/admission-selector/apply-staging-asia-proof', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminStagingAsiaProofAdmissionApplySchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const current = await operations.assignments.inspectCellAdmissionSelector()
      const result = await operations.assignments.applyCellAdmissionSelector({
        attemptId: body.data.attemptId,
        expectedGeneration: body.data.expectedGeneration,
        membership: stagingAsiaProofMembership(current.selector.membership, body.data.state)
      })
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/admission-selector/status', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminAdmissionSelectorStatusSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await operations.assignments.inspectCellAdmissionSelector(
        body.data.attemptId
      )
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/admission-selector/add-migration-cells', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminAdmissionSelectorAddMigrationCellsSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await operations.assignments.addMigrationCells({
        attemptId: body.data.attemptId,
        expectedGeneration: body.data.expectedGeneration,
        cells: body.data.cells.map((cell) => ({
          id: cell.cellId,
          url: cell.cellUrl,
          capacityRequests: cell.capacityRequests,
          region: cell.region,
          connectionHardCap: cell.connectionHardCap,
          connectionUnobservedBound: cell.connectionUnobservedBound
        }))
      })
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-state', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellStateSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.setCellAdmissionState(
        body.data.cellId,
        'state' in body.data
          ? body.data.state
          : body.data.enabled
          ? 'general'
          : 'existing-only'
      )
      return context.json({ ok: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-adopt-legacy', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceLegacyAdoptionSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const expiresAt = await operations.assignments.adoptLegacyCellFence(
        body.data.cellId,
        body.data.cellIncarnation
      )
      return context.json({ v: 1, cellId: body.data.cellId, expiresAt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-commit-legacy-adoption', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceLegacyAdoptionCommitSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.commitLegacyCellFenceAdoption(
        body.data.cellId,
        body.data.cellIncarnation
      )
      return context.json({ v: 1, cellId: body.data.cellId, committed: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attest', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceAttestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const result = await operations.assignments.attestCellFenceAttempt(
        evidence,
        body.data.gceOperation
      )
      return context.json({
        v: 1,
        cellId: body.data.cellId,
        expiresAt: result.expiresAt,
        attempt: result.attempt
      })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-prepare', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceAttemptPrepareSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const attempt = await operations.assignments.prepareCellFenceAttempt(evidence)
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-start', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceAttemptUpdateSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const result = await operations.assignments.startCellFenceApply(
        evidence,
        body.data.invocationId,
        body.data.invocationRequestReason
      )
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-plan', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFencePlanSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const attempt = await operations.assignments.bindCellFencePlanGeneration(
        evidence,
        body.data.planObjectGeneration
      )
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-operation', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceOperationSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const result = await operations.assignments.recordCellFenceOperation(
        evidence,
        body.data.invocationId,
        body.data.invocationRequestReason,
        body.data.gceOperation
      )
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-status', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceAttemptStatusSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const attempt = await operations.assignments.cellFenceAttempt(body.data.cellId)
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-fence-attempt-abort', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellFenceAttemptAbortSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const evidence = cellFenceAttemptEvidence(body.data)
      const attempt = await operations.assignments.abortCellFenceAttempt(evidence)
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/drain-attempt-prepare', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminDrainAttemptPrepareSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await operations.assignments.prepareCellDrainAttempt({
        attemptId: body.data.attemptId,
        cellId: body.data.cellId,
        cellIncarnation: body.data.cellIncarnation,
        traceValue: body.data.traceValue,
        plannedGraceMs: body.data.graceMs
      })
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/drain-attempt-send', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminDrainAttemptMutationSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const attempt = await operations.assignments.beginCellDrainSend(body.data)
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/drain-attempt-receipt', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminDrainAttemptReceiptSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const attempt = await operations.assignments.recordCellDrainApplicationReceipt(
        body.data
      )
      return context.json({ v: 1, attempt })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/drain-attempt-recover-forward', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminDrainAttemptRecoverSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const result = await operations.assignments.prepareCellDrainRecovery(body.data)
      return context.json({ v: 1, ...result })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/cell-config', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellConfigSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      await operations.assignments.configureCell(
        {
          id: body.data.cellId,
          url: body.data.cellUrl,
          capacityRequests: body.data.capacityRequests,
          connectionHardCap: body.data.connectionHardCap,
          connectionUnobservedBound: body.data.connectionUnobservedBound
        },
        'state' in body.data ? body.data.state : body.data.enabled
      )
      return context.json({ ok: true })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/evacuate-cell', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellEvacuateSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const started = await operations.assignments.startActiveCellEvacuations(
        body.data.sourceCellId,
        body.data.targetCellId,
        body.data.limit
      )
      return context.json({ v: 1, started })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/evacuation-capacity', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellEvacuationCapacitySchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const capacity = await operations.assignments.cellEvacuationCapacity(
        body.data.sourceCellId,
        body.data.targetCellId
      )
      return context.json({ v: 1, ...capacity })
    } catch (error) {
      return context.json({ error: operationError(error) }, 409)
    }
  })
  app.post('/v1/admin/evacuation-status', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellEvacuationStatusSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    if (body.data.completeReady && (await verifyReadOnlyAdminToken(bearer))) {
      return context.json({ error: 'insufficient_permission' }, 403)
    }
    const status = await operations.assignments.cellEvacuationStatus(
      body.data.sourceCellId,
      body.data.targetCellId,
      body.data.completeReady
    )
    return context.json({ v: 1, ...status })
  })
  app.post('/v1/admin/cell-status', async (context) => {
    const bearer = readBearer(context.req.header('authorization'))
    if (config.role !== 'director') return context.json({ error: 'director_only' }, 404)
    if (!bearer || !(await verifyAdminToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (requestTooLarge(context.req.header('content-length'))) {
      return context.json({ error: 'request_too_large' }, 413)
    }
    const body = AdminCellStatusSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid_request' }, 400)
    try {
      const status = await operations.assignments.cellDeploymentStatus(body.data.cellId)
      return context.json({ v: 1, status })
    } catch (error) {
      return context.json({ error: operationError(error) }, 404)
    }
  })
  return app
}

const AdminAssignmentMoveSchema = z
  .object({
    v: z.literal(1),
    userId: z.string().min(1).max(256),
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    targetCellId: z.string().min(1).max(128)
  })
  .strict()

const RuntimeStatusSchema = z.object({ v: z.literal(1) }).strict()

const RegionalRehomeSafetySchema = z
  .object({
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sqlFailures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reconnects: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    controlActivityRecoveryFailures: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    databasePoolWaiting: z.number().int().nonnegative().max(100),
    databasePoolWaitersMax: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    databasePoolWaitMsMax: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    // Cells spread the full pool-pressure counts into the payload; rejecting
    // the extra gauges 400'd every rehome-status heartbeat since 2026-08-15,
    // so no cell ever recorded rehome protocol 1.
    databasePoolTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    databasePoolIdle: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    databasePoolOldestWaitMs: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
  })
  .strict()

const CellHeartbeatSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1).max(128),
    cellUrl: z.string().url().max(2_048).refine(isCanonicalRelayOrigin),
    region: RelayRegionSchema.default(RELAY_DEFAULT_REGION),
    cellIncarnation: z.string().uuid(),
    startedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    ready: z.boolean(),
    observedRequests: z.number().int().nonnegative().max(RELAY_MAX_CELL_CAPACITY_REQUESTS),
    totalConnections: z
      .number()
      .int()
      .nonnegative()
      .max(RELAY_MAX_CELL_CAPACITY_REQUESTS)
      .optional(),
    inFlightConnections: z
      .number()
      .int()
      .nonnegative()
      .max(RELAY_MAX_CELL_CAPACITY_REQUESTS)
      .optional(),
    reservedConnectionUnits: z
      .number()
      .int()
      .nonnegative()
      .max(RELAY_MAX_CELL_CAPACITY_REQUESTS)
      .optional(),
    enforcedConnectionUnits: z
      .number()
      .int()
      .nonnegative()
      .max(RELAY_MAX_CELL_CAPACITY_REQUESTS)
      .optional(),
    connectionInclusionWatermark: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    connectionHardCap: RelayCellConnectionHardCapSchema.optional(),
    connectionUnobservedBound: z
      .number()
      .int()
      .nonnegative()
      .max(RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND)
      .optional()
  })
  .strict()
  .superRefine((value, context) => {
    const values = [
      value.totalConnections,
      value.inFlightConnections,
      value.reservedConnectionUnits,
      value.enforcedConnectionUnits,
      value.connectionHardCap,
      value.connectionUnobservedBound
    ]
    if (
      values.some((candidate) => candidate !== undefined) &&
      values.some((candidate) => candidate === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'connection telemetry must be complete'
      })
    }
    if (
      value.enforcedConnectionUnits !== undefined &&
      value.totalConnections !== undefined &&
      value.inFlightConnections !== undefined &&
      value.reservedConnectionUnits !== undefined &&
      value.enforcedConnectionUnits !==
        value.totalConnections +
          value.inFlightConnections +
          value.reservedConnectionUnits
    ) {
      context.addIssue({
        code: 'custom',
        message: 'connection telemetry sum does not match'
      })
    }
    if (
      value.connectionHardCap !== undefined &&
      value.connectionUnobservedBound! >
        relayCellAdmissionBounds(value.connectionHardCap).maxUnobservedBound
    ) {
      context.addIssue({
        code: 'custom',
        message: 'connection unobserved bound must leave ordinary admission capacity'
      })
    }
  })

const CellRegionalRehomeStatusSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid(),
    regionalRehomeProtocol: z.number().int().min(0).max(1),
    safety: RegionalRehomeSafetySchema
  })
  .strict()

const RegionalRehomeControlSchema = z.discriminatedUnion('action', [
  z.object({ v: z.literal(1), action: z.literal('inspect') }).strict(),
  z.object({
    v: z.literal(1),
    action: z.literal('apply'),
    expectedGeneration: z.number().int().nonnegative(),
    enabled: z.boolean(),
    notBefore: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ratePerMinute: z.number().int().min(1).max(120),
    preferenceMaxAgeMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000),
    drainGraceMs: z.number().int().min(60_000).max(60 * 60_000),
    confirmation: z.enum([
      'ENABLE_REGIONAL_REHOMING',
      'DISABLE_REGIONAL_REHOMING'
    ])
  }).strict()
]).superRefine((value, context) => {
  if (value.action !== 'apply') return
  const expected = value.enabled
    ? 'ENABLE_REGIONAL_REHOMING'
    : 'DISABLE_REGIONAL_REHOMING'
  if (value.confirmation !== expected) {
    context.addIssue({ code: 'custom', message: 'confirmation does not match state' })
  }
})

const RegionalRehomeTrustProbeSchema = z
  .object({
    v: z.literal(1),
    sourceCellId: z.string().min(1).max(128),
    sourceCellIncarnation: z.string().uuid()
  })
  .strict()

const AdminMigrationCompleteSchema = z
  .object({
    v: z.literal(1),
    userId: z.string().min(1).max(256),
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    assignmentEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const AdminRegisteredCellMigrationSupersedeSchema = z
  .object({
    v: z.literal(1),
    sourceCellId: z.string().min(1).max(128),
    currentTargetCellId: z.string().min(1).max(128),
    replacementTargetCellId: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(100),
    confirmation: z.literal('SUPERSEDE_REGISTERED_CELL_MIGRATIONS')
  })
  .strict()
  .refine(
    (value) =>
      new Set([
        value.sourceCellId,
        value.currentTargetCellId,
        value.replacementTargetCellId
      ]).size === 3
  )

const CellIdSchema = z.string().min(1).max(128)
const CellAdmissionStateSchema = z.enum(CELL_ADMISSION_STATES)
const AdmissionSelectorAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
const AdmissionSelectorMembershipSchema = z
  .object({
    existingOnly: z.array(CellIdSchema).max(256),
    migrationOnly: z.array(CellIdSchema).max(256),
    general: z.array(CellIdSchema).max(256)
  })
  .strict()

const AdminAdmissionSelectorApplySchema = z
  .object({
    v: z.literal(1),
    attemptId: AdmissionSelectorAttemptIdSchema,
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expectedMembershipSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    membership: AdmissionSelectorMembershipSchema
  })
  .strict()
  .refine(
    (value) => value.expectedGeneration > 0 || value.expectedMembershipSha256 !== undefined
  )

const AdminStagingAsiaProofAdmissionApplySchema = z
  .object({
    v: z.literal(1),
    attemptId: AdmissionSelectorAttemptIdSchema,
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['general', 'migration-only'])
  })
  .strict()

const AdminAdmissionSelectorStatusSchema = z
  .object({ v: z.literal(1), attemptId: AdmissionSelectorAttemptIdSchema.optional() })
  .strict()

const AdminAdmissionSelectorAddMigrationCellsSchema = z
  .object({
    v: z.literal(1),
    attemptId: AdmissionSelectorAttemptIdSchema,
    expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cells: z
      .array(
        z
          .object({
            cellId: CellIdSchema,
            cellUrl: z.string().url().max(2_048).refine(isCanonicalRelayOrigin),
            capacityRequests: z
              .number()
              .int()
              .positive()
              .max(RELAY_MAX_CELL_CAPACITY_REQUESTS),
            region: RelayRegionSchema.default(RELAY_DEFAULT_REGION),
            connectionHardCap: RelayCellConnectionHardCapSchema,
            connectionUnobservedBound: z
              .number()
              .int()
              .nonnegative()
              .max(RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND)
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.connectionUnobservedBound >
              relayCellAdmissionBounds(value.connectionHardCap).maxUnobservedBound
            ) {
              context.addIssue({
                code: 'custom',
                path: ['connectionUnobservedBound'],
                message: 'connection unobserved bound must leave ordinary admission capacity'
              })
            }
          })
      )
      .min(1)
      .max(128)
  })
  .strict()
  .refine(
    ({ cells }) =>
      new Set(cells.map(({ cellId }) => cellId)).size === cells.length &&
      new Set(cells.map(({ cellUrl }) => cellUrl)).size === cells.length
  )

const AdminCellStateSchema = z.union([
  z.object({ v: z.literal(1), cellId: CellIdSchema, enabled: z.boolean() }).strict(),
  z.object({ v: z.literal(1), cellId: CellIdSchema, state: CellAdmissionStateSchema }).strict()
])

const CellConfigShape = {
  v: z.literal(1),
  cellId: CellIdSchema,
  cellUrl: z.string().url().max(2_048).refine(isCanonicalRelayOrigin),
  capacityRequests: z.number().int().positive().max(RELAY_MAX_CELL_CAPACITY_REQUESTS),
  connectionHardCap: RelayCellConnectionHardCapSchema.optional(),
  connectionUnobservedBound: z
    .number()
    .int()
    .nonnegative()
    .max(RELAY_MAX_CELL_CONNECTION_UNOBSERVED_BOUND)
    .optional()
} as const

const AdminCellConfigSchema = z
  .union([
    z
      .object({
        ...CellConfigShape,
        enabled: z.boolean()
      })
      .strict(),
    z
      .object({
        ...CellConfigShape,
        state: CellAdmissionStateSchema
      })
      .strict()
  ])
  .refine(
    (value) =>
      (value.connectionHardCap === undefined) ===
      (value.connectionUnobservedBound === undefined),
    { message: 'connection hard cap and unobserved bound must be configured together' }
  )
  .refine(
    (value) =>
      value.connectionHardCap === undefined ||
      value.connectionUnobservedBound! <=
        relayCellAdmissionBounds(value.connectionHardCap).maxUnobservedBound,
    { message: 'connection unobserved bound must leave ordinary admission capacity' }
  )

const CellPairShape = {
  v: z.literal(1),
  sourceCellId: z.string().min(1).max(128),
  targetCellId: z.string().min(1).max(128)
} as const

const AdminCellEvacuateSchema = z
  .object({ ...CellPairShape, limit: z.number().int().min(1).max(100) })
  .strict()
  .refine((value) => value.sourceCellId !== value.targetCellId)

const AdminCellEvacuationCapacitySchema = z
  .object(CellPairShape)
  .strict()
  .refine((value) => value.sourceCellId !== value.targetCellId)

const AdminCellEvacuationStatusSchema = z
  .object({ ...CellPairShape, completeReady: z.boolean().default(false) })
  .strict()
  .refine((value) => value.sourceCellId !== value.targetCellId)

const TerraformStateLineageSchema = z
  .string()
  .regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)

const CellFenceAttemptBaseShape = {
  attemptId: z.string().uuid(),
  environment: z.enum(['staging', 'production']),
  cellId: z.string().min(1).max(128),
  cellIncarnation: z.string().uuid(),
  migName: z.string().min(1).max(128),
  instanceGroup: z.string().url().max(2048),
  generationIdentity: z.string().url().max(2048),
  fenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  planObjectName: z
    .string()
    .regex(/^terraform\/state\/relay-fence-plans\/(?:staging|production)\/[0-9a-f-]{36}\.tfplan$/),
  varFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  terraformStateLineage: TerraformStateLineageSchema,
  terraformStateSerial: z.number().int().nonnegative().safe(),
  terraformStateObjectGeneration: z.string().regex(/^[1-9][0-9]{0,30}$/),
  terraformStateObjectSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestReason: z
    .string()
    .regex(/^orca-relay-fence\/[0-9a-f]{8}-[0-9a-f-]{27}$/)
} as const
const CellFenceAttemptEvidenceShape = {
  ...CellFenceAttemptBaseShape,
  planObjectGeneration: z.string().regex(/^[1-9][0-9]{0,30}$/)
} as const

const AdminCellFenceAttemptPrepareSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptBaseShape,
    confirmation: z.literal('PREPARE_TERRAFORM_CELL_FENCE')
  })
  .strict()

const AdminCellFencePlanSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptEvidenceShape,
    confirmation: z.literal('BIND_TERRAFORM_CELL_FENCE_PLAN')
  })
  .strict()

const AdminCellFenceAttemptUpdateSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptEvidenceShape,
    invocationId: z.string().uuid(),
    invocationRequestReason: z.string().min(1).max(256),
    confirmation: z.literal('START_TERRAFORM_CELL_FENCE')
  })
  .strict()

const AdminCellFenceOperationSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptEvidenceShape,
    invocationId: z.string().uuid(),
    invocationRequestReason: z.string().min(1).max(256),
    gceOperation: z.string().min(1).max(256),
    confirmation: z.literal('RECORD_TERRAFORM_CELL_FENCE_OPERATION')
  })
  .strict()

const AdminCellFenceAttemptStatusSchema = z
  .object({ v: z.literal(1), cellId: z.string().min(1).max(128) })
  .strict()

const AdminCellFenceLegacyAdoptionSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid(),
    confirmation: z.literal('ADOPT_LEGACY_TERRAFORM_CELL_FENCE')
  })
  .strict()

const AdminCellFenceLegacyAdoptionCommitSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid(),
    confirmation: z.literal('COMMIT_LEGACY_TERRAFORM_CELL_FENCE_ADOPTION')
  })
  .strict()

const AdminCellFenceAttemptAbortSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptBaseShape,
    confirmation: z.literal('ABORT_UNSTARTED_TERRAFORM_CELL_FENCE')
  })
  .strict()

const AdminCellFenceAttestSchema = z
  .object({
    v: z.literal(1),
    ...CellFenceAttemptEvidenceShape,
    gceOperation: z.string().min(1).max(256),
    confirmation: z.literal('ATTEST_TERRAFORM_FENCED_CELL')
  })
  .strict()

const AdminDrainAttemptPrepareSchema = z
  .object({
    v: z.literal(1),
    attemptId: z.string().uuid(),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid(),
    traceValue: z.string().uuid(),
    graceMs: z.literal(120_000),
    confirmation: z.literal('PREPARE_LEGACY_DRAIN')
  })
  .strict()

const AdminDrainAttemptMutationSchema = z
  .object({
    v: z.literal(1),
    attemptId: z.string().uuid(),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid()
  })
  .strict()

const AdminDrainAttemptReceiptSchema = AdminDrainAttemptMutationSchema.extend({
  traceValue: z.string().uuid(),
  backendStatus: z.number().int().min(200).max(299),
  backendInstance: z.string().min(1).max(256).optional()
}).strict()

const AdminDrainAttemptRecoverSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1).max(128),
    cellIncarnation: z.string().uuid(),
    confirmation: z.literal('RECOVER_LEGACY_DRAIN')
  })
  .strict()

const RegionalHostDrainSchema = z
  .object({
    v: z.literal(1),
    attemptId: z.string().uuid(),
    userId: z.string().min(1).max(256),
    relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    sourceCellId: z.string().min(1).max(128),
    sourceCellIncarnation: z.string().uuid(),
    sourceAssignmentEpoch: z.number().int().positive(),
    graceMs: z.number().int().nonnegative().max(60 * 60 * 1000)
  })
  .strict()

const AdminCellStatusSchema = z
  .object({ v: z.literal(1), cellId: z.string().min(1).max(128) })
  .strict()

function cellFenceAttemptEvidence(
  value: CellFenceAttemptEvidence
): CellFenceAttemptEvidence {
  return {
    attemptId: value.attemptId,
    environment: value.environment,
    cellId: value.cellId,
    cellIncarnation: value.cellIncarnation,
    migName: value.migName,
    instanceGroup: value.instanceGroup,
    generationIdentity: value.generationIdentity,
    fenceCommit: value.fenceCommit,
    planSha256: value.planSha256,
    planObjectName: value.planObjectName,
    planObjectGeneration: value.planObjectGeneration,
    varFileSha256: value.varFileSha256,
    terraformStateLineage: value.terraformStateLineage,
    terraformStateSerial: value.terraformStateSerial,
    terraformStateObjectGeneration: value.terraformStateObjectGeneration,
    terraformStateObjectSha256: value.terraformStateObjectSha256,
    requestReason: value.requestReason
  }
}

function operationError(error: unknown): string {
  return error instanceof Error ? error.message : 'operation_failed'
}

export { relayHostLogDigest }

// `suppressed` is present only on a window-closing line, and counts the rejections
// that line stands for beyond the one already logged when the window opened.
function logAssignmentRejection(input: {
  route: 'assign' | 'assign-verify' | 'resolve'
  lane: 'sticky' | 'placement' | 'none'
  hinted: boolean
  relayHostId: string
  reason: string
  suppressed?: number
}): void {
  console.warn(
    `[orca-relay] assignment rejected route=${input.route} lane=${input.lane}` +
      ` hinted=${input.hinted} reason=${input.reason}` +
      ` host=${relayHostLogDigest(input.relayHostId)}` +
      (input.suppressed === undefined ? '' : ` suppressed=${input.suppressed}`)
  )
}

function isRelayAssignmentCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['relay_capacity_exhausted', 'relay_connection_headroom_exhausted'].includes(
      error.message
    )
  )
}

function isCanonicalRelayOrigin(value: string): boolean {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  return (
    url.origin === value &&
    url.pathname === '/' &&
    (url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
  )
}

function requestTooLarge(contentLength: string | undefined): boolean {
  return Number(contentLength ?? 0) > RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes
}
