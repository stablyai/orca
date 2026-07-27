import { DaemonServer, type DaemonServerOptions } from './daemon-server'
import type { DaemonFileLog } from './daemon-file-log'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  /** Direct-construction seam for versioned protocol fixtures; never CLI/env configured. */
  protocolVersion?: number
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
  preparePtySpawn?: DaemonServerOptions['preparePtySpawn']
  onPtySessionExit?: DaemonServerOptions['onPtySessionExit']
  onAuthenticatedClientPair?: DaemonServerOptions['onAuthenticatedClientPair']
  log?: DaemonFileLog
  onIdleShutdown?: () => void
  initialAdoptionTestConfig?: DaemonServerOptions['initialAdoptionTestConfig']
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    ...(opts.pidPath ? { pidPath: opts.pidPath } : {}),
    ...(opts.launchNonce ? { launchNonce: opts.launchNonce } : {}),
    ...(opts.startedAtMs ? { startedAtMs: opts.startedAtMs } : {}),
    ...(opts.protocolVersion !== undefined ? { protocolVersion: opts.protocolVersion } : {}),
    spawnSubprocess: opts.spawnSubprocess,
    ...(opts.preparePtySpawn ? { preparePtySpawn: opts.preparePtySpawn } : {}),
    ...(opts.onPtySessionExit ? { onPtySessionExit: opts.onPtySessionExit } : {}),
    ...(opts.onAuthenticatedClientPair
      ? { onAuthenticatedClientPair: opts.onAuthenticatedClientPair }
      : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.onIdleShutdown ? { onIdleShutdown: opts.onIdleShutdown } : {}),
    ...(opts.initialAdoptionTestConfig
      ? { initialAdoptionTestConfig: opts.initialAdoptionTestConfig }
      : {})
  })

  await server.start()

  return {
    shutdown: () => server.shutdown()
  }
}
