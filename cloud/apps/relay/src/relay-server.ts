import { createAdaptorServer } from '@hono/node-server'
import {
  hasAdmissionCapacity,
  HostDataAuthSchema,
  parseRelayHostCapabilities,
  RELAY_ASSIGNMENT_LEASE_HEADER,
  RELAY_ADMISSION_BUDGETS,
  RELAY_HOST_CAPABILITIES_HEADER,
  RELAY_CLOSE_CODE,
  RELAY_DEFAULT_REGION,
  RELAY_PROTOCOL_LIMITS,
  RelayAuthSchema,
  cellPlacementCeiling
} from '@orca-cloud/relay-contract'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import { CellAdmitEffectiveWriter } from './cell-admit-effective-writer.js'
import { ReserveDeadMan, reserveDeadManWindowMs } from './cell-reserve-dead-man.js'
import { createRelayApp } from './app.js'
import { classifyAssignmentLease } from './assignment/assignment-lease.js'
import { defaultIntakePerSec, type CellFlags } from './cell-flags.js'
import { CellReserveBook } from './cell-reserve-book.js'
import type { DemoteRequest, ReserveRequest } from './cell-reserve-contract.js'
import { AssignmentLeaseShadow } from './assignment/assignment-lease-shadow.js'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { RelayCredentialStore } from './credential-store.js'
import {
  readRelayDatabasePoolOldestWaitMs,
  readRelayDatabasePoolPressure,
  type RelayDatabase
} from './database.js'
import { HostSessionRegistry } from './host-session-registry.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import { RelayObservability } from './relay-observability.js'
import { combineRegionalRehomeSafety } from './regional-rehome-safety.js'
import { RelayConnectionLedger, type RelayConnectionUpgrade } from './relay-connection-ledger.js'
import { PlacementLoadBand } from './placement-load-band.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import { createRelayLocalReadiness } from './relay-local-readiness.js'
import { createRelayReadiness } from './relay-readiness.js'
import { createRelayTokenVerifier, readBearer } from './relay-token-verifier.js'
import { createStaleIfErrorJWKSet } from './stale-if-error-jwks.js'
import { closeRelayWebSocket } from './relay-websocket-close.js'
import { ShadowDirectoryCompare } from './shadow-directory-compare.js'
import { type ShadowSeatPoller, startShadowSeatPoller } from './shadow-seat-directory.js'
import { CellReserveClient } from './cell-reserve-client.js'
import { googleMetadataIdentityToken, reusedIdentityToken } from './google-metadata-identity-token.js'
import { ReserveAssignment } from './reserve-assignment.js'
import { ReservePlacer } from './reserve-placement.js'
import { ReserveRehome, ReserveRehomeSwitch } from './reserve-rehome.js'
import {
  reconcileReserveLedger,
  RESERVE_LEDGER_RECONCILE_MS,
  ReserveLedgerWriter
} from './reserve-ledger-writer.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

// Malformed upgrade paths must return client errors; an uncaught listener URIError kills the process.
function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

// Healthy cells peak at 2 waiters; a pool’s worth queued past half the 2s timeout means hellos already fail. Count floor ignores lone slow waiters.
export const HOST_HELLO_SHED_OLDEST_WAIT_MS = 1_000
const HOST_HELLO_SHED_RETRY_AFTER_SECONDS = 2
// Well inside the flag channel's 5 s read, so a flip back starts re-registering within ~6 s.
export const RESERVE_MODE_WATCH_MS = 1_000
// Shipped desktops ignore it; it is for the ones that learn to read it.
const CELL_FULL_RETRY_AFTER_SECONDS = 2

function rejectUpgrade(
  socket: NodeJS.WritableStream,
  status: number,
  message: string,
  retryAfterSeconds?: number
): void {
  const retryAfter = retryAfterSeconds === undefined ? '' : `Retry-After: ${retryAfterSeconds}\r\n`
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n${retryAfter}Connection: close\r\nContent-Length: 0\r\n\r\n`
  )
  if ('destroy' in socket && typeof socket.destroy === 'function') socket.destroy()
}

function noDelay(socket: WebSocket): void {
  const transport = (socket as WebSocket & { _socket?: { setNoDelay: (enabled: boolean) => void } })
    ._socket
  transport?.setNoDelay(true)
}

// Handle ws receiver errors or they crash the process; ws already closes the socket.
function guardSocketErrors(socket: WebSocket, kind: string): void {
  socket.on('error', (error) => {
    console.warn(`[orca-relay] ${kind} socket error: ${error.message}`)
  })
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function admissionSource(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for']
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  // Google Front End appends client and load-balancer addresses after any
  // caller-supplied values, so only the penultimate hop is trustworthy.
  return chain.length >= 2 ? chain.at(-2)! : (request.socket.remoteAddress ?? 'unknown')
}

function firstPayload(raw: RawData, expectedType: string): unknown {
  try {
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>
    if (parsed.type !== expectedType) return null
    const { type: _type, ...rest } = parsed
    return rest
  } catch {
    return null
  }
}

export function createRelayServer(
  config: RelayConfig,
  database: RelayDatabase,
  options: {
    now?: () => number
    random?: () => number
    connectionLedgerLimits?: { hardCap: number; controlReserve: number }
    cellIncarnation?: string
    cellFlags?: () => AppliedControlFlags<CellFlags>
  } = {}
) {
  const cellIncarnation = options.cellIncarnation ?? randomUUID()
  const observability = new RelayObservability({
    role: config.role,
    cellId: config.cellId,
    region: config.region ?? RELAY_DEFAULT_REGION
  })
  const observedDatabase = observeRelayDatabase(database, observability)
  const controls = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024
  })
  const relayJwks = createStaleIfErrorJWKSet(new URL(config.jwksUrl))
  const verifyRelayToken = createRelayTokenVerifier(config, relayJwks)
  const store = new RelayCredentialStore(observedDatabase, options.now)
  // Bound once the poller below exists; without one, no poll ever reads as dead.
  const pollEvidence: { deadCellVerdict?: ShadowSeatPoller['deadCellVerdict'] } = {}
  const assignments = new RelayAssignmentStore(observedDatabase, options.now, {
    requireLiveCells: config.role === 'director',
    placementLoadBand: config.role === 'director' ? new PlacementLoadBand(options.random) : undefined,
    regionalRehomeCohortPercent: config.regionCorrectionCohortPercent ?? 0,
    // The director runs in the database's region; only its rehome readers use this.
    regionalRehomeDirectorRegion:
      config.role === 'director' ? (config.region ?? RELAY_DEFAULT_REGION) : undefined,
    recordControlRenewal: (durationMs, outcome) =>
      observability.recordControlRenewal?.(durationMs, outcome),
    deadCellVerdict: (cellId, now) => pollEvidence.deadCellVerdict?.(cellId, now) ?? null
  })
  const readiness = createRelayReadiness(observedDatabase, config.jwksUrl, {
    jwksGraceMs: config.readinessJwksGraceMs,
    sqlGraceMs: config.readinessSqlGraceMs,
    observe: (observation) => observability.recordReadiness(observation),
    observeGrace: (event) => observability.recordReadinessGrace(event)
  })
  const ready = readiness.check
  // Only actual booking activity may feed reserve dead-man; configured-on directors missing map/credentials book nothing.
  const placing = { on: false }
  const shadowSeatPoller = startShadowSeatPoller(config, {
    listCells: () => assignments.seatFeedCells(),
    reserver: () => placing.on
  })
  pollEvidence.deadCellVerdict = shadowSeatPoller?.deadCellVerdict
  const shadowCompare = shadowSeatPoller
    ? new ShadowDirectoryCompare(shadowSeatPoller.directory, options.now)
    : undefined
  const directorId = randomUUID()
  const rehomeAudience = config.rehomeAudience
  // Only a director that books writes rows, and only for the joins it booked.
  const reserveLedger =
    config.role === 'director' && shadowSeatPoller && config.reservePlacement === 'on'
      ? new ReserveLedgerWriter(observedDatabase, { now: options.now })
      : undefined
  const rehomePercent = config.reserveRehomePercent ?? 0
  const rehomeSwitch =
    config.role === 'director' && shadowSeatPoller && rehomeAudience && config.reservePlacement === 'on' && rehomePercent > 0
      ? new ReserveRehomeSwitch(async () => await assignments.regionRehomeSwitch(), options.now)
      : undefined
  rehomeSwitch?.start()
  const reservePlacement =
    config.role === 'director' &&
    shadowSeatPoller &&
    rehomeAudience &&
    (config.reservePlacement ?? 'off') !== 'off'
      ? new ReserveAssignment({
          mode: config.reservePlacement ?? 'off',
          directory: shadowSeatPoller.directory,
          cells: shadowSeatPoller.cells,
          startedAt: shadowSeatPoller.startedAt,
          placer: new ReservePlacer(options.now, options.random),
          client: new CellReserveClient({
            directorId,
            identityToken: reusedIdentityToken(
              () => googleMetadataIdentityToken(rehomeAudience),
              options.now
            )
          }),
          readRow: async (identity) => await assignments.hostWhereabouts(identity),
          databaseBusy: () => readRelayDatabasePoolPressure(database).databasePoolWaiting > 0,
          ...(rehomeSwitch
            ? {
                rehome: new ReserveRehome({
                  percent: rehomePercent,
                  switchOpen: (now) => rehomeSwitch.isOpen(now)
                })
              }
            : {}),
          now: options.now,
          random: options.random
        })
      : undefined
  placing.on = reservePlacement?.placementMode === 'on'
  // Warn until dead-man flips back: non-placing directors otherwise strand reserve-cell hosts in memory.
  const offWithReserveTimer =
    config.role === 'director' && shadowSeatPoller && !placing.on
      ? setInterval(() => {
          const { directory } = shadowSeatPoller
          const cells = directory.cellIds().filter((cellId) => directory.admitModeOf(cellId) === 'reserve')
          if (cells.length === 0) return
          console.error(
            JSON.stringify({
              event: 'orca_relay_reserve_placement_off_with_reserve_cells',
              cells,
              placement: reservePlacement?.placementMode ?? 'off',
              configured: config.reservePlacement ?? 'off'
            })
          )
        }, 60_000)
      : null
  offWithReserveTimer?.unref()
  if (reserveLedger && shadowSeatPoller) {
    const directory = shadowSeatPoller.directory
    directory.onBookedJoin = (join) => {
      if (join.reservedBy !== directorId) return
      reserveLedger.enqueue({
        userId: join.userId,
        relayHostId: join.relayHostId,
        cellId: join.cellId,
        epoch: join.epoch
      })
    }
    directory.onOutranked = (seat) => reservePlacement?.supersedeOutranked(seat)
    reserveLedger.start()
    const reconcile = (): void => {
      const now = (options.now ?? Date.now)()
      void reconcileReserveLedger({
        writer: reserveLedger,
        seats: () =>
          directory
            .cellIds()
            .filter((cellId) => directory.admitModeOf(cellId) === 'reserve')
            .flatMap((cellId) =>
              directory.seatsOnCell(cellId).map(({ userId, relayHostId, seat }) => ({
                userId,
                relayHostId,
                cellId,
                epoch: seat.epoch,
                joinedAt: seat.joinedAt
              }))
            ),
        demote: (seat, row) => {
          reservePlacement?.demoteSeat(seat, 'reconcile')
          // The re-assign mints above the row, so the mirror can take it.
          reservePlacement?.raiseEpochFloor(seat, row.epoch)
          console.warn(
            JSON.stringify({
              event: 'orca_relay_reserve_ledger_seat_behind_row',
              cellId: seat.cellId,
              epoch: seat.epoch,
              rowEpoch: row.epoch
            })
          )
        },
        now
      })
        .catch(() => console.warn('[orca-relay] reserve ledger reconcile deferred'))
        .finally(schedule)
    }
    // Jittered, so five directors do not reconcile together.
    const schedule = (): void => {
      const random = options.random ?? Math.random
      setTimeout(reconcile, RESERVE_LEDGER_RECONCILE_MS + random() * 60_000).unref?.()
    }
    // A restart loses the queue: the first run goes as soon as the map is complete.
    const clock = options.now ?? Date.now
    const bootedAt = clock()
    const firstRun = setInterval(() => {
      if (!directory.isComplete() && clock() - bootedAt < RESERVE_LEDGER_RECONCILE_MS) return
      clearInterval(firstRun)
      reconcile()
    }, 1_000)
    firstRun.unref?.()
  }
  const configuredConnectionLimits =
    config.connectionHardCap === undefined
      ? null
      : (options.connectionLedgerLimits ?? {
          hardCap: config.connectionHardCap,
          controlReserve: RELAY_ADMISSION_BUDGETS.reservedHostControls
        })
  const connectionLedger =
    configuredConnectionLimits === null
      ? null
      : new RelayConnectionLedger(
          configuredConnectionLimits.hardCap,
          configuredConnectionLimits.controlReserve
        )
  const placementCeiling =
    config.connectionHardCap === undefined || config.connectionUnobservedBound === undefined
      ? null
      : cellPlacementCeiling(config.connectionHardCap, config.connectionUnobservedBound)
  const reserveBook =
    config.role === 'cell' && connectionLedger && placementCeiling !== null
      ? new CellReserveBook(
          {
            tryReserve: () => connectionLedger.tryReserveBooking(placementCeiling),
            canReserve: () => connectionLedger.canReserveBooking(placementCeiling)
          },
          () =>
            options.cellFlags?.().flags.intakePerSec ?? defaultIntakePerSec(config.region),
          options.now
        )
      : null
  const databaseShedding = (): boolean =>
    readRelayDatabasePoolPressure(database).databasePoolWaiting >= config.databasePoolMax &&
    readRelayDatabasePoolOldestWaitMs(database) >= HOST_HELLO_SHED_OLDEST_WAIT_MS
  const reserveDeadMan = reserveBook
    ? new ReserveDeadMan(config.cellId, options.now, reserveDeadManWindowMs(config.cellId))
    : null
  const effectiveAdmitMode = (): 'db' | 'reserve' => {
    const applied = options.cellFlags?.()
    if (!applied) return 'db'
    return reserveDeadMan ? reserveDeadMan.mode(applied) : applied.flags.admitMode
  }
  const queuedBytes = new ProcessQueuedByteBudget()
  const sessions = new HostSessionRegistry(
    config,
    verifyRelayToken,
    store,
    assignments,
    queuedBytes,
    observability,
    options.now,
    options.random,
    cellIncarnation,
    new AssignmentLeaseShadow({
      enabled: () => options.cellFlags?.().flags.ticketCheck === 'shadow',
      key: config.assignmentSigningKey,
      cellId: config.cellId
    }),
    reserveBook
      ? {
          mode: effectiveAdmitMode,
          directorContact: () => reserveDeadMan?.contact(),
          reregisterInFlight: () => options.cellFlags?.().flags.reregisterInFlight,
          phonePath: () => options.cellFlags?.().flags.phonePath ?? 'db',
          ticketEnforce: () => options.cellFlags?.().flags.ticketCheck === 'enforce',
          dryRunEnabled: () => options.cellFlags?.().flags.reserveDryRun === true,
          databaseShedding: () => databaseShedding(),
          book: reserveBook,
          verifyLease: (input) =>
            classifyAssignmentLease({
              ...input,
              key: config.assignmentSigningKey,
              cellId: config.cellId
            })
        }
      : undefined
  )
  // Expire booking units even with no reserving directors; leaving reserve also re-registers memory controls.
  let appliedAdmitMode = effectiveAdmitMode()
  const admitEffective =
    config.role === 'cell' && reserveBook
      ? new CellAdmitEffectiveWriter({
          write: async (mode) =>
            await assignments.recordCellAdmitEffective({ cellId: config.cellId, cellIncarnation, mode }),
          claimTrip: async (slots) =>
            await assignments.claimDeadManTripSlot({ cellId: config.cellId, cellIncarnation, slots }),
          databaseBusy: () => readRelayDatabasePoolPressure(database).databasePoolWaiting > 0,
          now: options.now ?? Date.now
        })
      : undefined
  const reserveSweepTimer = reserveBook
    ? setInterval(() => {
        reserveBook.sweep()
        const admitMode = effectiveAdmitMode()
        if (appliedAdmitMode === 'reserve' && admitMode !== 'reserve') {
          reserveBook.clear()
          sessions.reregisterMemoryControls()
        }
        appliedAdmitMode = admitMode
        // A booted cell runs db defaults until its first flag read, so it writes nothing until then.
        const held = reserveDeadMan?.pendingTrip()
        admitEffective?.tick(
          admitMode,
          options.cellFlags?.().flags.admitMode === 'reserve',
          held ? { slots: held.slots, permit: () => reserveDeadMan?.permit(held.generation) } : null
        )
      }, RESERVE_MODE_WATCH_MS)
    : null
  reserveSweepTimer?.unref()
  const app = createRelayApp(config, {
    store,
    assignments,
    drain: (graceMs, options) => sessions.drain(graceMs, options ?? {}),
    drainHost: (input) => sessions.drainHost(input),
    idleRehome: (input) => {
      const now = (options.now ?? Date.now)()
      if (input.directorSafety.observedAt > now || now - input.directorSafety.observedAt > 60_000) {
        return Promise.resolve({ outcome: 'deferred', reason: 'director-safety-stale' })
      }
      return sessions.idleRehome(input,
        () => assignments.commitIdleRegionalRehome(input, combineRegionalRehomeSafety(
          input.directorSafety,
          { ...observability.regionalRehomeRuntimeSafety(), ...readRelayDatabasePoolPressure(database) }
        ), input.cohortPercent),
        () => assignments.reconcileIdleRegionalRehome(input)
      )
    },
    regionalRehomeTrustProbeHostExists: (input) => sessions.get(input) !== null,
    cellIncarnation,
    cellSeatFeed: (sinceSeq) => sessions.seatFeed(sinceSeq),
    cellFlags: options.cellFlags,
    ...(reserveBook && placementCeiling !== null
      ? {
          cellReserve: (request: ReserveRequest) => sessions.reserve(request),
          cellReserverPoll: () => reserveDeadMan?.contact(),
          // Report reserve until every memory control has a lease; flag workflow must wait before recording db and resuming sweeps.
          cellAdmitModeRaw: effectiveAdmitMode,
          cellAdmitModeEffective: (): 'db' | 'reserve' =>
            effectiveAdmitMode() === 'reserve' || sessions.reregistrationPending() > 0
              ? 'reserve'
              : 'db',
          cellPhonePathEffective: () => sessions.phonePathEffective(),
          cellDemote: (request: DemoteRequest) => sessions.demote(request),
          cellReserveCounts: () => sessions.reserveCounts(),
          cellPlacementCeiling: placementCeiling
        }
      : {}),
    isDraining: () => sessions.isDraining(),
    runtimeCounts: () => runtimeCounts(),
    regionalRehomeSafetySnapshot: () => ({
      ...observability.regionalRehomeRuntimeSafety(),
      ...readRelayDatabasePoolPressure(database)
    }),
    ready,
    readinessDegradation: () => readiness.degradedDependencies(),
    readinessLocal: () => options.cellFlags?.().flags.readinessLocal ?? false,
    relayJwks,
    localReadiness: createRelayLocalReadiness({
      listening: () => server.listening,
      keys: relayJwks,
      failingDependencies: () => readiness.failingDependencies()
    }),
    recordAssignmentAdmission: (outcome) => observability.recordAssignmentAdmission?.(outcome),
    recordAssignmentRejectionReason: (lane, reason) =>
      observability.recordAssignmentRejectionReason?.(lane, reason),
    recordDrainReturnRetryAfter: (seconds) => observability.recordDrainReturnRetryAfter?.(seconds),
    recordAdmissionServiceMs: (lane, durationMs) =>
      observability.recordAdmissionServiceMs?.(lane, durationMs),
    recordStickySlot: (sample) => observability.recordStickySlot?.(sample),
    recordAssignmentUnavailable: (cause) => observability.recordAssignmentUnavailable?.(cause),
    recordRegionRequest: (region) => observability.recordRegionRequest?.(region),
    shadowSeats: shadowSeatPoller?.directory,
    reservePlacement,
    compareShadowSeats: shadowCompare
      ? (route, identity, answer) => {
          shadowCompare.compare(route, identity, answer)
        }
      : undefined,
    recordRegionSelection: (input) => observability.recordRegionSelection?.(input)
  })
  const observedFetch: typeof app.fetch = async (...args) => {
    const startedAt = performance.now()
    try {
      return await app.fetch(...args)
    } finally {
      observability.recordHttp(performance.now() - startedAt)
    }
  }
  const server = createAdaptorServer({ fetch: observedFetch })
  const clients = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: RELAY_PROTOCOL_LIMITS.maxFrameBytes
  })
  const dataSockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: RELAY_PROTOCOL_LIMITS.maxFrameBytes
  })
  let preAuthConnections = 0
  let totalConnections = 0
  const preAuthBySource = new Map<string, number>()
  const preAuthAttemptsBySource = new Map<string, { windowStartedAt: number; count: number }>()

  const admit = (source: string): boolean => {
    const now = Date.now()
    const currentWindow = preAuthAttemptsBySource.get(source)
    const attempts =
      !currentWindow || now - currentWindow.windowStartedAt >= 60_000
        ? { windowStartedAt: now, count: 0 }
        : currentWindow
    const sourceCount = preAuthBySource.get(source) ?? 0
    if (
      !hasAdmissionCapacity({
        totalRequests:
          connectionLedger?.counts().physicalConnections ?? totalConnections,
        preAuthConnections,
        sourcePreAuthConnections: sourceCount,
        totalRequestCeiling:
          configuredConnectionLimits === null
            ? undefined
            : configuredConnectionLimits.hardCap - configuredConnectionLimits.controlReserve
      }) ||
      attempts.count >= RELAY_ADMISSION_BUDGETS.maxPreAuthAttemptsPerSourcePerMinute
    ) {
      return false
    }
    attempts.count++
    preAuthAttemptsBySource.delete(source)
    preAuthAttemptsBySource.set(source, attempts)
    // A bounded LRU keeps source churn from becoming its own memory attack.
    if (preAuthAttemptsBySource.size > 4_096) {
      preAuthAttemptsBySource.delete(preAuthAttemptsBySource.keys().next().value!)
    }
    preAuthConnections++
    preAuthBySource.set(source, sourceCount + 1)
    return true
  }
  const authenticated = (source: string): void => {
    preAuthConnections = Math.max(0, preAuthConnections - 1)
    const next = (preAuthBySource.get(source) ?? 1) - 1
    if (next <= 0) preAuthBySource.delete(source)
    else preAuthBySource.set(source, next)
  }

  const trackConnection = (
    socket: WebSocket,
    upgrade: RelayConnectionUpgrade | null
  ): void => {
    if (upgrade) {
      upgrade.promote(socket)
      return
    }
    totalConnections++
    socket.once('close', () => {
      totalConnections = Math.max(0, totalConnections - 1)
    })
  }

  const awaitFirstFrame = (
    socket: WebSocket,
    source: string,
    callback: (raw: RawData) => Promise<void>
  ): void => {
    let finished = false
    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      authenticated(source)
      observability.recordAuth(false)
      closeRelayWebSocket(socket, RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    }, RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs)
    socket.once('message', (raw, binary) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      authenticated(source)
      if (binary) {
        observability.recordAuth(false)
        closeRelayWebSocket(
          socket,
          RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
          'first frame must be text'
        )
        return
      }
      void callback(raw).catch((error: unknown) => {
        console.warn(
          '[orca-relay] first frame handler failed',
          error instanceof Error ? error.message : ''
        )
        closeRelayWebSocket(
          socket,
          RELAY_CLOSE_CODE.LIMIT_EXCEEDED,
          'relay temporarily unavailable'
        )
      })
    })
    socket.once('close', () => {
      if (!finished) {
        finished = true
        clearTimeout(timer)
        authenticated(source)
      }
    })
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', config.publicUrl)
    const source = admissionSource(request)
    if (url.search) {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    if (url.pathname.startsWith('/v1/connect/')) {
      const hostId = decodePathSegment(url.pathname.slice('/v1/connect/'.length))
      if (hostId === null || !/^[A-Za-z0-9_-]{16}$/.test(hostId)) {
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      const phoneAdmission = connectionLedger?.tryReservePhone() ?? null
      if (connectionLedger && !phoneAdmission) {
        rejectUpgrade(socket, 503, 'Service Unavailable')
        return
      }
      if (!admit(source)) {
        phoneAdmission?.upgrade.release()
        phoneAdmission?.hostData.release()
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      const releasePhoneUpgrade = (): void => {
        authenticated(source)
        phoneAdmission?.upgrade.release()
        phoneAdmission?.hostData.release()
      }
      socket.once('close', releasePhoneUpgrade)
      try {
        clients.handleUpgrade(request, socket, head, (webSocket) => {
          socket.off('close', releasePhoneUpgrade)
          trackConnection(webSocket, phoneAdmission?.upgrade ?? null)
          guardSocketErrors(webSocket, 'client')
          if (phoneAdmission) {
            webSocket.once('close', () => phoneAdmission.hostData.release())
          }
          noDelay(webSocket)
          awaitFirstFrame(webSocket, source, async (raw) => {
            const auth = RelayAuthSchema.safeParse(firstPayload(raw, 'relay-auth'))
            if (!auth.success) {
              phoneAdmission?.hostData.release()
              observability.recordAuth(false)
              webSocket.send(
                JSON.stringify({ type: 'relay-hello', ok: false, code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL })
              )
              closeRelayWebSocket(
                webSocket,
                RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
                'invalid relay auth'
              )
              return
            }
            if (config.role === 'director') {
              const invite = await store.resolveInviteForMove(hostId, auth.data.credential)
              const identity = invite ? { userId: invite.userId, relayHostId: hostId } : null
              // Released combined-service invites gain their first durable cell assignment here.
              const assignment = identity
                ? ((await assignments.resolve(identity)) ?? (await assignments.assign(identity)))
                : null
              if (!invite || !assignment) {
                phoneAdmission?.hostData.release()
                observability.recordAuth(false)
                webSocket.send(
                  JSON.stringify({
                    type: 'relay-hello',
                    ok: false,
                    code: RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
                  })
                )
                closeRelayWebSocket(
                  webSocket,
                  RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
                  'invalid invite'
                )
                return
              }
              phoneAdmission?.hostData.release()
              observability.recordAuth(true)
              webSocket.send(
                JSON.stringify({
                  type: 'relay-moved',
                  v: 1,
                  cellUrl: assignment.cellUrl,
                  assignmentEpoch: assignment.assignmentEpoch
                })
              )
              closeRelayWebSocket(webSocket, RELAY_CLOSE_CODE.DRAINING, 'connect to assigned cell')
              return
            }
            await sessions.acceptClient(
              webSocket,
              hostId,
              auth.data.credential,
              phoneAdmission?.hostData
            )
          })
        })
      } catch {
        socket.off('close', releasePhoneUpgrade)
        releasePhoneUpgrade()
        socket.destroy()
      }
      return
    }
    if (url.pathname.startsWith('/v1/host/data/')) {
      if (config.role === 'director') {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      const connId = decodePathSegment(url.pathname.slice('/v1/host/data/'.length))
      if (!connId || connId.length > 128) {
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      const dataUpgrade = connectionLedger?.tryReserveHostData(connId) ?? null
      if (connectionLedger && !dataUpgrade) {
        rejectUpgrade(socket, 503, 'Service Unavailable')
        return
      }
      if (!admit(source)) {
        dataUpgrade?.release()
        rejectUpgrade(socket, 429, 'Too Many Requests')
        return
      }
      const releaseDataUpgrade = (): void => {
        authenticated(source)
        dataUpgrade?.release()
      }
      socket.once('close', releaseDataUpgrade)
      try {
        dataSockets.handleUpgrade(request, socket, head, (webSocket) => {
          socket.off('close', releaseDataUpgrade)
          trackConnection(webSocket, dataUpgrade)
          guardSocketErrors(webSocket, 'host-data')
          noDelay(webSocket)
          awaitFirstFrame(webSocket, source, async (raw) => {
            const auth = HostDataAuthSchema.safeParse(firstPayload(raw, 'host-data-auth'))
            if (!auth.success) {
              observability.recordAuth(false)
              closeRelayWebSocket(
                webSocket,
                RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL,
                'invalid host data auth'
              )
              return
            }
            const accepted = await sessions.acceptHostData(
              webSocket,
              connId,
              auth.data.connTicket,
              auth.data.generation
            )
            if (accepted) dataUpgrade?.commitHostData()
          })
        })
      } catch {
        socket.off('close', releaseDataUpgrade)
        releaseDataUpgrade()
        socket.destroy()
      }
      return
    }
    if (url.pathname !== '/v1/host/control') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    if (config.role === 'director') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    const bearer = readBearer(request.headers.authorization)
    if (!bearer) {
      observability.recordAuth(false)
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    void verifyRelayToken(bearer).then((identity) => {
      if (socket.destroyed) return
      if (!identity) {
        observability.recordAuth(false)
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      const isRebind = sessions.hasActiveControl({
        userId: identity.sub,
        relayHostId: identity.relayHostId
      })
      const reserveAdmission = sessions.reserveAdmissionFor({
        userId: identity.sub,
        relayHostId: identity.relayHostId
      })
      // Shed before several 2s pool waits; shipped desktops use ordinary connect-error backoff and ignore Retry-After.
      // Preserve live-control rebinds: they rotate leases rather than reconnect.
      if (!isRebind && reserveAdmission === null && databaseShedding()) {
        observability.recordHostHelloShed()
        rejectUpgrade(socket, 503, 'Service Unavailable', HOST_HELLO_SHED_RETRY_AFTER_SECONDS)
        return
      }
      // Booked upgrades can reach hard cap; return booking unit only after upgrade reserves its own, counting host once.
      const controlUpgrade =
        connectionLedger?.tryReserveControl(isRebind || reserveAdmission === 'booked') ?? null
      if (controlUpgrade && reserveAdmission === 'booked') {
        reserveBook?.handOff(identity.sub, identity.relayHostId)
      }
      if (
        (connectionLedger && !controlUpgrade) ||
        (!connectionLedger && totalConnections >= RELAY_ADMISSION_BUDGETS.cloudRunConcurrency)
      ) {
        rejectUpgrade(
          socket,
          connectionLedger ? 503 : 429,
          connectionLedger ? 'Service Unavailable' : 'Too Many Requests',
          connectionLedger && sessions.inReserveMode() ? CELL_FULL_RETRY_AFTER_SECONDS : undefined
        )
        return
      }
      // Register release before other work can throw; outer-catch socket destruction must return the connection unit.
      const releaseControlUpgrade = (): void => controlUpgrade?.release()
      socket.once('close', releaseControlUpgrade)
      observability.recordAuth(true)
      try {
        controls.handleUpgrade(request, socket, head, (webSocket) => {
          socket.off('close', releaseControlUpgrade)
          trackConnection(webSocket, controlUpgrade)
          guardSocketErrors(webSocket, 'control')
          noDelay(webSocket)
          sessions.acceptControl(
            webSocket,
            identity,
            controlUpgrade?.inclusionWatermark,
            parseRelayHostCapabilities(request.headers[RELAY_HOST_CAPABILITIES_HEADER]),
            firstHeader(request.headers[RELAY_ASSIGNMENT_LEASE_HEADER])
          )
        })
      } catch {
        socket.off('close', releaseControlUpgrade)
        releaseControlUpgrade()
        socket.destroy()
      }
    }).catch((error: unknown) => {
      // A throw in the upgrade handling above must cost this socket, not the process.
      console.warn(
        `[orca-relay] control upgrade failed: ${error instanceof Error ? error.message : 'unknown'}`
      )
      socket.destroy()
    })
  })

  server.on('close', () => {
    controls.close()
    clients.close()
    dataSockets.close()
    store.resumeAudit.stop()
    rehomeSwitch?.stop()
  })
  const resumeAuditDropped = (): number => {
    const drops = store.resumeAudit.drops()
    return drops.overflow + drops.aged
  }
  const runtimeCounts = () => {
    const ledgerCounts = connectionLedger?.counts()
    return {
      totalConnections: ledgerCounts?.physicalConnections ?? totalConnections,
      preAuthConnections,
      ...sessions.runtimeCounts(),
      queuedBytes: queuedBytes.current(),
      ...(config.role === 'cell' ? { resumeAuditDropped: resumeAuditDropped() } : {}),
      ...(ledgerCounts
        ? {
            inFlightConnections: ledgerCounts.inFlightConnections,
            reservedConnectionUnits: ledgerCounts.reservedConnectionUnits,
            enforcedConnectionUnits: ledgerCounts.enforcedConnectionUnits
          }
        : {})
    }
  }
  const connectionSnapshot = () => connectionLedger?.snapshot()
  return {
    server,
    sessions,
    store,
    assignments,
    queuedBytes,
    observability,
    runtimeCounts,
    connectionSnapshot,
    ready,
    cellIncarnation,
    shadowSeatPoller,
    directorId,
    reservePlacement
  }
}
