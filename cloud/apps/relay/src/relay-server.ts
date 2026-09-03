import { createAdaptorServer } from '@hono/node-server'
import {
  hasAdmissionCapacity,
  HostDataAuthSchema,
  RELAY_ADMISSION_BUDGETS,
  RELAY_CLOSE_CODE,
  RELAY_DEFAULT_REGION,
  RELAY_PROTOCOL_LIMITS,
  RelayAuthSchema
} from '@orca-cloud/relay-contract'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import type { RawData } from 'ws'
import { createRelayApp } from './app.js'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { RelayCredentialStore } from './credential-store.js'
import type { RelayDatabase } from './database.js'
import { HostSessionRegistry } from './host-session-registry.js'
import { observeRelayDatabase } from './observed-relay-database.js'
import { RelayObservability } from './relay-observability.js'
import {
  RelayConnectionLedger,
  type RelayConnectionUpgrade
} from './relay-connection-ledger.js'
import { createRelayReadiness } from './relay-readiness.js'
import { createRelayTokenVerifier, readBearer } from './relay-token-verifier.js'
import { closeRelayWebSocket } from './relay-websocket-close.js'
import { ProcessQueuedByteBudget } from './splice-forwarder.js'

function rejectUpgrade(socket: NodeJS.WritableStream, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  if ('destroy' in socket && typeof socket.destroy === 'function') socket.destroy()
}

function noDelay(socket: WebSocket): void {
  const transport = (socket as WebSocket & { _socket?: { setNoDelay: (enabled: boolean) => void } })
    ._socket
  transport?.setNoDelay(true)
}

// Why: a ws receiver error (oversize or malformed frame) with no 'error'
// listener throws process-wide; ws itself already closes the socket after
// emitting it, so logging is all that is left to do.
function guardSocketErrors(socket: WebSocket, kind: string): void {
  socket.on('error', (error) => {
    console.warn(`[orca-relay] ${kind} socket error: ${error.message}`)
  })
}

function admissionSource(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for']
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
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
    connectionLedgerLimits?: { hardCap: number; controlReserve: number }
    cellIncarnation?: string
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
  const verifyRelayToken = createRelayTokenVerifier(config)
  const store = new RelayCredentialStore(observedDatabase, options.now)
  const assignments = new RelayAssignmentStore(observedDatabase, options.now, {
    requireLiveCells: config.role === 'director',
    recordControlRenewal: (durationMs, outcome) =>
      observability.recordControlRenewal?.(durationMs, outcome)
  })
  const ready = createRelayReadiness(observedDatabase, config.jwksUrl, {
    observe: (observation) => observability.recordReadiness(observation)
  })
  const queuedBytes = new ProcessQueuedByteBudget()
  const sessions = new HostSessionRegistry(
    config,
    verifyRelayToken,
    store,
    assignments,
    queuedBytes,
    observability,
    options.now
  )
  const app = createRelayApp(config, {
    store,
    assignments,
    drain: (graceMs) => sessions.drain(graceMs),
    drainHost: (input) => sessions.drainHost(input),
    regionalRehomeTrustProbeHostExists: (input) => sessions.get(input) !== null,
    cellIncarnation,
    isDraining: () => sessions.isDraining(),
    runtimeCounts: () => runtimeCounts(),
    ready,
    recordAssignmentAdmission: (outcome) => observability.recordAssignmentAdmission?.(outcome),
    recordAssignmentRejectionReason: (lane, reason) =>
      observability.recordAssignmentRejectionReason?.(lane, reason),
    recordRegionRequest: (region) => observability.recordRegionRequest?.(region),
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
      socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame timeout')
    }, RELAY_PROTOCOL_LIMITS.firstFrameDeadlineMs)
    socket.once('message', (raw, binary) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      authenticated(source)
      if (binary) {
        observability.recordAuth(false)
        socket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'first frame must be text')
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
      const hostId = decodeURIComponent(url.pathname.slice('/v1/connect/'.length))
      if (!/^[A-Za-z0-9_-]{16}$/.test(hostId)) {
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
              webSocket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid relay auth')
              return
            }
            if (config.role === 'director') {
              const invite = await store.resolveInviteForMove(hostId, auth.data.credential)
              const identity = invite ? { userId: invite.userId, relayHostId: hostId } : null
              // Released combined-service invites gain their first durable cell assignment here.
              const assignment = identity
                ? (await assignments.resolve(identity)) ?? (await assignments.assign(identity))
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
                webSocket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid invite')
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
              webSocket.close(RELAY_CLOSE_CODE.DRAINING, 'connect to assigned cell')
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
      const connId = decodeURIComponent(url.pathname.slice('/v1/host/data/'.length))
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
              webSocket.close(RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'invalid host data auth')
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
      const controlUpgrade = connectionLedger?.tryReserveControl(isRebind) ?? null
      if (
        (connectionLedger && !controlUpgrade) ||
        (!connectionLedger && totalConnections >= RELAY_ADMISSION_BUDGETS.cloudRunConcurrency)
      ) {
        rejectUpgrade(
          socket,
          connectionLedger ? 503 : 429,
          connectionLedger ? 'Service Unavailable' : 'Too Many Requests'
        )
        return
      }
      // Register the release before anything else can throw: the outer catch
      // destroys the socket, so a close-registered release cannot leak the
      // reserved connection unit.
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
            controlUpgrade?.inclusionWatermark
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
  })
  const runtimeCounts = () => {
    const ledgerCounts = connectionLedger?.counts()
    return {
      totalConnections: ledgerCounts?.physicalConnections ?? totalConnections,
      preAuthConnections,
      ...sessions.runtimeCounts(),
      queuedBytes: queuedBytes.current(),
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
    cellIncarnation
  }
}

export function closeWithDrain(socket: WebSocket, graceMs: number): void {
  socket.send(JSON.stringify({ type: 'drain', graceMs, recovery: 'resolve-director' }))
  socket.close(RELAY_CLOSE_CODE.DRAINING, 'resolve configured director')
}
