import { parentPort } from 'node:worker_threads'
import { spawnHostedProvider } from '../../daemon/server/daemon-provider-spawn'
import type { ProviderLauncherReply, ProviderLauncherRequest } from './provider-launcher-protocol'

if (!parentPort) {
  throw new Error('Provider launcher worker requires a parent port.')
}
const port = parentPort

// Owners stay this thread's children until they exit, so it must outlive them to reap them.
port.on('message', (request: ProviderLauncherRequest) => {
  void spawnHostedProvider(request.launch, true).then(
    (result) => port.postMessage({ id: request.id, result } satisfies ProviderLauncherReply),
    (error: unknown) =>
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      } satisfies ProviderLauncherReply)
  )
})
