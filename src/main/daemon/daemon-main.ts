import { DaemonServer, type DaemonServerOptions } from './daemon-server'

export type DaemonStartOptions = {
  socketPath: string
  tokenPath: string
  spawnSubprocess: DaemonServerOptions['spawnSubprocess']
}

export type DaemonHandle = {
  shutdown(): Promise<void>
}

export async function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle> {
  const server = new DaemonServer({
    socketPath: opts.socketPath,
    tokenPath: opts.tokenPath,
    spawnSubprocess: opts.spawnSubprocess
  })

  await server.start()

  return {
    shutdown: () => server.shutdown()
  }
}
