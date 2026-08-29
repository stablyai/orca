import { resolveDesktopHostListenConfig } from './desktop-host-config'
import { startDesktopHostServer } from './desktop-host-server'

async function main(): Promise<void> {
  const config = resolveDesktopHostListenConfig()
  const host = await startDesktopHostServer(config)
  console.log(`[desktop-host] ${host.info.host} listening on ${host.info.httpUrl}`)
  console.log(`[desktop-host] ipc ${host.info.ipcUrl}`)
  console.log(`[desktop-host] runtime ${host.info.runtimeId}`)

  const shutdown = async (): Promise<void> => {
    await host.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error('[desktop-host] failed to start', error)
  process.exit(1)
})
