import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BackendBootstrapSchema, BACKEND_CAPABILITIES } from '../../shared/backend-service-contract'
import { BackendPortRpc } from '../../shared/backend-port-rpc'
import { setAppEnvironment } from '../../shared/app-environment'
import { agentTokenUsageSchema } from '../../shared/telemetry-agent-token-usage-schema'
import { backendMessagePort, type BackendNativePort } from './backend-message-port'
import { createDesktopBackendEnvironment } from './node-service-environment'
import { BackendServiceLifetime, activateBackendServices } from './service-composition'
import { acquireOrcadInstanceLock } from '../orcad/orcad-instance-lock'
import { OrcadInstanceLockError } from '../orcad/orcad-data-root-privacy'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from '../orcad/orcad-stop-deadlines'
import { clearWindowsStdHandleInheritance } from '../startup/windows-startup/windows-std-handle-inheritance'
import { installWindowsIsolatedSpawner } from '../startup/windows-startup/windows-isolated-spawner'
import { dropE2eSpawnLogOutsideE2e } from '../startup/testing/e2e-spawn-log-env'
import { ignoreInheritedWslHostsGateState } from '../../shared/wsl-host-internal-gate'
import type { createUsageService } from './usage-service'
import type { UsageWorktreeCatalog } from '../usage/usage-store-host'

dropE2eSpawnLogOutsideE2e()
clearWindowsStdHandleInheritance()
installWindowsIsolatedSpawner()
ignoreInheritedWslHostsGateState()

const parent:
  | {
      on(
        event: 'message',
        listener: (event: { data: unknown; ports: BackendNativePort[] }) => void
      ): unknown
      postMessage(message: unknown): void
    }
  | undefined = process.parentPort
if (!parent) {
  throw new Error('Backend must be launched by its desktop supervisor.')
}
const incarnation = randomUUID()
const lifetime = new BackendServiceLifetime()
const abort = new AbortController()
const clients = new Map<string, BackendPortRpc>()
let control: BackendPortRpc | undefined
let usage: ReturnType<typeof createUsageService> | undefined
let stopping: Promise<void> | undefined
let booting = false
let startup: Promise<void> | undefined

function stop(): Promise<void> {
  stopping ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), ORCAD_SHUTDOWN_DEADLINE_MS)
    abort.abort(new Error('Backend is stopping.'))
    for (const client of clients.values()) {
      client.close()
    }
    try {
      await startup?.catch(() => {})
      await lifetime.stop()
      parent!.postMessage({ type: 'stopped', incarnation })
      clearTimeout(deadline)
      process.exit(0)
    } catch {
      console.error(`[backend ${incarnation}] Shutdown did not finish cleanly.`)
      process.exit(1)
    }
  })()
  return stopping
}

async function acquireServiceLock(userDataPath: string) {
  const deadline = Date.now() + ORCAD_SHUTDOWN_DEADLINE_MS
  while (!abort.signal.aborted) {
    try {
      return acquireOrcadInstanceLock(join(userDataPath, 'backend-service'), {
        role: 'orcad',
        enforcePrivateDataRoot: false,
        onExclusivityLost: () => {
          void stop()
        }
      })
    } catch (error) {
      if (
        !(error instanceof OrcadInstanceLockError) ||
        error.code !== 'orcad_instance_lock_held' ||
        Date.now() >= deadline
      ) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
  }
  throw abort.signal.reason
}

async function bootstrap(raw: unknown, port: BackendNativePort): Promise<void> {
  if (booting) {
    port.close()
    throw new Error('Backend was already bootstrapped.')
  }
  booting = true
  const config = BackendBootstrapSchema.parse(raw)
  if (
    config.requiredCapabilities.some(
      (capability) => !BACKEND_CAPABILITIES.some((offered) => offered === capability)
    )
  ) {
    throw new Error('Backend contract is unsupported.')
  }
  const host = createDesktopBackendEnvironment(config)
  setAppEnvironment(host.environment)
  control = new BackendPortRpc(
    backendMessagePort(port),
    incarnation,
    async (method, params, signal) => {
      if (method === 'backend.stop') {
        void stop()
        return null
      }
      if (!usage) {
        throw new Error('Usage is still starting. Try again shortly.')
      }
      await usage.ready
      return usage.invoke(method, params, true, signal)
    },
    () => {
      void stop()
    }
  )
  const lock = await acquireServiceLock(config.paths.userData)
  // Release only after services and their worker writers have retired.
  lifetime.add(({ failed }) => {
    if (!failed) {
      lock.release()
    }
  })
  abort.signal.throwIfAborted()
  lifetime.add(() => host.runQuitHandlers())
  await activateBackendServices({
    supervised: true,
    registerCleanup: (cleanup) => lifetime.add(cleanup),
    activate: async (registerCleanup) => {
      const { createUsageService } = await import('./usage-service')
      abort.signal.throwIfAborted()
      const call = async (method: string, params?: unknown): Promise<unknown> => {
        return control!.call(method, params)
      }
      usage = createUsageService({
        signal: abort.signal,
        userDataPath: config.paths.userData,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private control peer returns the catalog directly from its typed Store adapter.
        readCatalog: async () => (await call('usage.catalog')) as UsageWorktreeCatalog,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The private control peer returns the account owner's typed string array.
        claudeProfileDirs: async () => (await call('usage.claudeProfileDirs')) as string[],
        telemetry: {
          isEnabled: async () => (await call('usage.telemetry.enabled')) === true,
          capture: async (snapshot) =>
            (await call('usage.telemetry.capture', agentTokenUsageSchema.parse(snapshot))) === true
        }
      })
      registerCleanup(() => usage!.stop())
      await usage.ready
    }
  })
  abort.signal.throwIfAborted()
  parent!.postMessage({
    type: 'ready',
    protocol: 1,
    capabilities: BACKEND_CAPABILITIES,
    incarnation,
    build: config.build
  })
}

parent.on('message', (event) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the owning desktop can send parent messages; every consumed field is validated below.
  const message = event.data as { type?: unknown; config?: unknown; token?: unknown }
  const [port, ...surplus] = event.ports
  for (const extra of surplus) {
    extra.close()
  }
  if (message?.type === 'bootstrap' && port) {
    startup = bootstrap(message.config, port)
    void startup.catch(() => {
      console.error(`[backend ${incarnation}] Startup failed.`)
      parent!.postMessage({ type: 'failed', incarnation })
      void stop()
    })
    return
  }
  if (message?.type === 'retire' && typeof message.token === 'string') {
    clients.get(message.token)?.close()
    port?.close()
    return
  }
  if (
    message?.type === 'client' &&
    typeof message.token === 'string' &&
    port &&
    usage &&
    !stopping
  ) {
    const token = message.token
    clients.get(token)?.close()
    let client: BackendPortRpc
    client = new BackendPortRpc(
      backendMessagePort(port),
      incarnation,
      async (method, params, signal) => {
        await usage!.ready
        return usage!.invoke(method, params, false, signal)
      },
      () => clients.delete(token)
    )
    clients.set(token, client)
    return
  }
  port?.close()
})
process.on('SIGTERM', () => {
  void stop()
})
process.on('SIGINT', () => {
  void stop()
})
