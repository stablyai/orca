import { fork, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { buildRelayAiVaultServiceEnv } from '../main/ai-vault/session-scanner-service-env'
import { lowerAiVaultServicePriority } from '../main/ai-vault/session-scanner-service-priority'

export function relayAiVaultServiceEntryPath(baseDir = __dirname): string {
  return join(baseDir, 'relay-ai-vault-service.js')
}

// See the matching constant in main/ai-vault/session-scanner-service-spawn.ts:
// libuv defaults to 4 threads, serializing local fs.stat/readdir discovery
// 4-wide regardless of JS-side batching width.
const RELAY_AI_VAULT_SERVICE_UV_THREADPOOL_SIZE = 16

export function spawnRelayAiVaultService(): ChildProcess {
  const child = fork(relayAiVaultServiceEntryPath(), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=384'],
    env: {
      ...buildRelayAiVaultServiceEnv(),
      UV_THREADPOOL_SIZE: String(RELAY_AI_VAULT_SERVICE_UV_THREADPOOL_SIZE)
    },
    ...(process.platform === 'win32' ? { windowsHide: true } : {})
  })
  lowerAiVaultServicePriority(child.pid)
  child.unref()
  return child
}
