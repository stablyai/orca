import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import { readAiVaultSessionTitlesFromFiles } from '../main/ai-vault/session-title-file-reader'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import {
  RELAY_AI_VAULT_SERVICE_PROTOCOL,
  isRelayAiVaultServiceRequest,
  relayAiVaultServiceLane,
  type RelayAiVaultServiceChildMessage,
  type RelayAiVaultServiceInit,
  type RelayAiVaultServiceParentMessage,
  type RelayAiVaultServiceRequest
} from './ai-vault-service-protocol'

if (!process.send) {
  throw new Error('Relay AI Vault service requires a parent IPC channel.')
}

const controllers = new Map<number, AbortController>()
const cancelled = new Set<number>()
const pending = new Set<number>()
const provider = createRelayAiVaultFilesystemProvider()
let init: RelayAiVaultServiceInit | null = null
let cacheLane = Promise.resolve()
let interactiveLane = Promise.resolve()
let shuttingDown = false

function send(message: RelayAiVaultServiceChildMessage): void {
  process.send?.(message)
}

async function execute(request: RelayAiVaultServiceRequest): Promise<void> {
  const controller = new AbortController()
  controllers.set(request.id, controller)
  if (cancelled.delete(request.id)) {
    controller.abort()
  }
  try {
    if (!init) {
      throw new Error('Relay AI Vault service is not initialized.')
    }
    if (request.operation === 'titles') {
      const value = await readAiVaultSessionTitlesFromFiles(request.requests, {
        signal: controller.signal
      })
      send({ type: 'result', id: request.id, operation: 'titles', value })
      return
    }
    const value = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      remoteHome: init.remoteHome,
      hostPlatform: init.hostPlatform,
      limit: request.params.limit,
      unlimited: request.params.unlimited,
      scopePaths: request.params.scopePaths,
      signal: controller.signal
    })
    send({ type: 'result', id: request.id, operation: 'list', value })
  } catch (error) {
    send({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    controllers.delete(request.id)
    cancelled.delete(request.id)
    pending.delete(request.id)
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const controller of controllers.values()) {
    controller.abort()
  }
  await Promise.allSettled([cacheLane, interactiveLane])
  process.disconnect?.()
}

process.on('message', (raw: RelayAiVaultServiceParentMessage) => {
  if (raw?.type === 'init') {
    if (init || raw.protocol !== RELAY_AI_VAULT_SERVICE_PROTOCOL) {
      void shutdown()
      return
    }
    init = raw
    send({ type: 'ready', protocol: RELAY_AI_VAULT_SERVICE_PROTOCOL, pid: process.pid })
    return
  }
  if (!init || shuttingDown) {
    return
  }
  if (raw?.type === 'cancel') {
    cancelled.add(raw.id)
    controllers.get(raw.id)?.abort()
    return
  }
  if (raw?.type === 'shutdown') {
    void shutdown()
    return
  }
  if (!isRelayAiVaultServiceRequest(raw)) {
    return
  }
  if (pending.size >= 16) {
    send({ type: 'error', id: raw.id, message: 'Relay AI Vault service queue is full.' })
    return
  }
  pending.add(raw.id)
  if (relayAiVaultServiceLane(raw.operation) === 'interactive') {
    interactiveLane = interactiveLane.then(() => execute(raw))
    return
  }
  cacheLane = cacheLane.then(() => execute(raw))
})

process.on('disconnect', () => void shutdown())
