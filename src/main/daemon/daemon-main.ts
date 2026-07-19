import { DaemonServer, type DaemonServerOptions } from './daemon-server'
import type { DaemonFileLog } from './daemon-file-log'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
  preparePtySpawn?: DaemonServerOptions['preparePtySpawn']
  log?: DaemonFileLog
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    spawnSubprocess: opts.spawnSubprocess,
    ...(opts.preparePtySpawn ? { preparePtySpawn: opts.preparePtySpawn } : {}),
    ...(opts.log ? { log: opts.log } : {})
  })

  await server.start()

  return {
    shutdown: () => server.shutdown()
  }
}
