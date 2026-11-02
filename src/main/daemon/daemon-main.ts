import { DaemonServer } from './daemon-server'
import type { DaemonServerOptions } from './daemon-server-options'
import type { DaemonFileLog } from './daemon-file-log'
import { readTerminalSpawnAdmissionArg } from './terminal-spawn-gate'
import { automaticWorkMarkerPathFor } from './automatic-work-run-marker-store'
import { defaultHostTerminalLedgerDir } from './host-terminal-ledger'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  publishEndpointOwnership?: DaemonServerOptions['publishEndpointOwnership']
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  /** Direct-construction seam for versioned protocol fixtures; never CLI/env configured. */
  protocolVersion?: number
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
  preparePtySpawn?: DaemonServerOptions['preparePtySpawn']
  onPtySessionExit?: DaemonServerOptions['onPtySessionExit']
  onAuthenticatedClientPair?: DaemonServerOptions['onAuthenticatedClientPair']
  log?: DaemonFileLog
  spawnAdmission?: DaemonServerOptions['spawnAdmission']
  automaticWorkMarkerPath?: string
  hostTerminalLedgerDir?: string
  onIdleShutdown?: () => void
  onRpcShutdown?: () => void
  onShutdownRequested?: () => void
  initialAdoptionTestConfig?: DaemonServerOptions['initialAdoptionTestConfig']
}

export type DaemonHandle = {
  shutdown(): Promise<void>
  /** Marks this run as ended on purpose when the process exits without a teardown. */
  recordOrderlyExit(): void
  /** Marks this run as stopped from outside before the teardown, which may not finish. */
  recordStopRequested(): void
  /** SIGKILLs each live PTY's process group synchronously, for a shutdown that overran its deadline. */
  killLiveSessionGroupsSync(): void
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  // Directly started test daemons must not join the real host count.
  const hostTerminalLedgerDir =
    opts.hostTerminalLedgerDir ?? (opts.pidPath ? defaultHostTerminalLedgerDir() : null)
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    ...(opts.pidPath ? { pidPath: opts.pidPath } : {}),
    ...(opts.launchNonce ? { launchNonce: opts.launchNonce } : {}),
    ...(opts.startedAtMs ? { startedAtMs: opts.startedAtMs } : {}),
    ...(opts.publishEndpointOwnership
      ? { publishEndpointOwnership: opts.publishEndpointOwnership }
      : {}),
    ...(opts.entryPath ? { entryPath: opts.entryPath } : {}),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
    ...(opts.spawnerExecPath ? { spawnerExecPath: opts.spawnerExecPath } : {}),
    ...(opts.protocolVersion !== undefined ? { protocolVersion: opts.protocolVersion } : {}),
    spawnSubprocess: opts.spawnSubprocess,
    ...(opts.preparePtySpawn ? { preparePtySpawn: opts.preparePtySpawn } : {}),
    ...(opts.onPtySessionExit ? { onPtySessionExit: opts.onPtySessionExit } : {}),
    ...(opts.onAuthenticatedClientPair
      ? { onAuthenticatedClientPair: opts.onAuthenticatedClientPair }
      : {}),
    ...(opts.log ? { log: opts.log } : {}),
    // Launchers pass argv; direct-construction tests pass the option.
    spawnAdmission: opts.spawnAdmission ?? readTerminalSpawnAdmissionArg(process.argv),
    // Launched daemons keep their marker beside the PID record.
    ...(opts.automaticWorkMarkerPath || opts.pidPath
      ? {
          automaticWorkMarkerPath:
            opts.automaticWorkMarkerPath ?? automaticWorkMarkerPathFor(opts.pidPath ?? '')
        }
      : {}),
    ...(hostTerminalLedgerDir ? { hostTerminalLedgerDir } : {}),
    ...(opts.onIdleShutdown ? { onIdleShutdown: opts.onIdleShutdown } : {}),
    ...(opts.onRpcShutdown ? { onRpcShutdown: opts.onRpcShutdown } : {}),
    ...(opts.onShutdownRequested ? { onShutdownRequested: opts.onShutdownRequested } : {}),
    ...(opts.initialAdoptionTestConfig
      ? { initialAdoptionTestConfig: opts.initialAdoptionTestConfig }
      : {})
  })

  await server.start()

  return {
    shutdown: () => server.shutdown(),
    recordOrderlyExit: () => server.automaticWork.recordOrderlyExit(),
    recordStopRequested: () => server.automaticWork.recordStopRequested(),
    killLiveSessionGroupsSync: () => server.host.killLiveSessionGroupsSync()
  }
}
