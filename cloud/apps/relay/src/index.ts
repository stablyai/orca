import {
  formatAssignmentInventorySnapshot,
  readAssignmentInventorySnapshot
} from './assignment-inventory-snapshot.js'
import { RelayAssignmentStore } from './assignment-store.js'
import { loadRelayConfig } from './config.js'
import { startCellHeartbeat } from './cell-heartbeat-client.js'
import {
  reconcileCellAdmissionAtStartup,
  roleOwnsAssignmentMaintenance
} from './cell-admission-startup.js'
import {
  consumeRelayDatabasePoolPressure,
  openRelayDatabase,
  readRelayDatabasePoolPressure
} from './database.js'
import { runAssignmentCleanup } from './assignment-cleanup-steps.js'
import { runRelayBackgroundOperation } from './relay-background-operation.js'
import { observedRelayRequests } from './relay-observability.js'
import { startRegionalRehomeWorker } from './regional-rehome-worker.js'
import { createRelayServer } from './relay-server.js'
import {
  formatRegisteredMigrationInventory,
  readRegisteredMigrationInventory
} from './registered-migration-inventory.js'

const config = loadRelayConfig()
const database = await openRelayDatabase({
  databaseUrl: config.databaseUrl,
  dataDir: config.dataDir,
  poolMax: config.databasePoolMax,
  applicationName: `orca-relay/${config.role}/${config.cellId}`
})
await reconcileCellAdmissionAtStartup(config, new RelayAssignmentStore(database))
const {
  server,
  sessions,
  store,
  assignments,
  observability,
  runtimeCounts,
  connectionSnapshot,
  ready,
  cellIncarnation
} = createRelayServer(config, database)
const cleanupTimer = setInterval(
  () =>
    void runRelayBackgroundOperation(
      () => store.cleanup(),
      '[orca-relay] credential cleanup failed'
    ),
  30_000
)
const assignmentCleanupTimer = roleOwnsAssignmentMaintenance(config.role)
  ? setInterval(() => {
      void runAssignmentCleanup(assignments)
    }, 30_000)
  : null
const inventorySnapshotTimer = roleOwnsAssignmentMaintenance(config.role)
  ? setInterval(() => {
      void runRelayBackgroundOperation(async () => {
        const snapshot = await readAssignmentInventorySnapshot(database, Date.now())
        for (const line of formatAssignmentInventorySnapshot(snapshot)) console.warn(line)
      }, '[orca-relay] inventory snapshot failed')
    }, 60_000)
  : null
const migrationInventoryTimer = roleOwnsAssignmentMaintenance(config.role)
  ? setInterval(() => {
      void runRelayBackgroundOperation(async () => {
        const inventory = await readRegisteredMigrationInventory(database, Date.now())
        for (const line of formatRegisteredMigrationInventory(inventory)) console.warn(line)
      }, '[orca-relay] migration inventory failed')
    }, 5 * 60_000)
  : null
cleanupTimer.unref()
assignmentCleanupTimer?.unref()
inventorySnapshotTimer?.unref()
migrationInventoryTimer?.unref()
observability.start(() => ({
  ...runtimeCounts(),
  ...consumeRelayDatabasePoolPressure(database)
}))
const regionalRehomeWorker = startRegionalRehomeWorker(config, assignments, {
  safetySnapshot: () => ({
    ...observability.regionalRehomeRuntimeSafety(),
    ...readRelayDatabasePoolPressure(database)
  })
})
const heartbeat = startCellHeartbeat(config, {
  ready,
  incarnation: cellIncarnation,
  observedRequests: () => observedRelayRequests(runtimeCounts()),
  connectionCounts: () => {
    const snapshot = connectionSnapshot()
    const counts = runtimeCounts()
    return {
      totalConnections: snapshot?.physicalConnections ?? counts.totalConnections,
      inFlightConnections:
        snapshot?.inFlightConnections ?? counts.inFlightConnections ?? 0,
      reservedConnectionUnits:
        snapshot?.reservedConnectionUnits ?? counts.reservedConnectionUnits ?? 0,
      enforcedConnectionUnits:
        snapshot?.enforcedConnectionUnits ??
        counts.enforcedConnectionUnits ??
        counts.totalConnections,
      inclusionWatermark: snapshot?.inclusionWatermark
    }
  },
  regionalRehomeSafety: () => ({
    ...observability.regionalRehomeRuntimeSafety(),
    ...readRelayDatabasePoolPressure(database)
  })
})

server.listen(config.port, () => {
  console.log(`[orca-relay] listening on ${config.publicUrl} (port ${config.port})`)
})

const shutdown = (): void => {
  clearInterval(cleanupTimer)
  if (assignmentCleanupTimer) clearInterval(assignmentCleanupTimer)
  if (inventorySnapshotTimer) clearInterval(inventorySnapshotTimer)
  if (migrationInventoryTimer) clearInterval(migrationInventoryTimer)
  observability.stop()
  heartbeat?.stop()
  regionalRehomeWorker?.stop()
  sessions.drain(0)
  server.close(() => void database.close())
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
