import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  BackendBootstrapSchema,
  BACKEND_CAPABILITIES,
  BACKEND_PUBLIC_USAGE_METHOD,
  UsageCallParams
} from '../../shared/backend/backend-service-contract'
import { BackendPortRpc } from '../../shared/backend/backend-port-rpc'
import { setAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { agentTokenUsageDailySchema } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import { backendMessagePort, type BackendNativePort } from './backend-message-port'
import { createDesktopBackendEnvironment } from './node-service-environment'
import { BackendDocumentPeers } from './backend-document-peers'
import { BackendServiceLifetime, activateBackendServices } from './service-composition'
import { acquireOrcadInstanceLock } from '../orcad/instance-lock/orcad-instance-lock'
import { OrcadInstanceLockError } from '../orcad/instance-lock/orcad-data-root-privacy'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from '../orcad/host-lifecycle/managed-stop/orcad-stop-deadlines'
import { clearWindowsStdHandleInheritance } from '../startup/windows-startup/windows-std-handle-inheritance'
import { installWindowsIsolatedSpawner } from '../startup/windows-startup/windows-isolated-spawner'
import { dropE2eSpawnLogOutsideE2e } from '../startup/testing/e2e-spawn-log-env'
import { ignoreInheritedWslHostsGateState } from '../../shared/remote-runtime/wsl-hosts/wsl-host-internal-gate'
import type { createUsageService } from './usage-service'
import type { UsageWorktreeCatalog } from '../usage/usage-store-host'
import { installFatalSignalListenerGuard } from '../crash-reporting/fatal-signal-listener-guard'
import { DESKTOP_OWNER_POLL_MS, watchDesktopOwner } from './backend-desktop-owner-watch'

// A fatal V8 trap must crash, never spin on a JS fault-signal listener.
installFatalSignalListenerGuard()
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
let control: BackendPortRpc | undefined
let usage: ReturnType<typeof createUsageService> | undefined
const documents = new BackendDocumentPeers(
  incarnation,
  async (_binding, method, params, signal) => {
    await usage!.ready
    return usage!.invoke(method, params, false, signal)
  }
)
let stopping: Promise<void> | undefined
let booting = false
let startup: Promise<void> | undefined
// Linux: no bootstrap means main died before sending it, and a leaked IPC fd can hide that.
const bootstrapDeadline =
  process.platform === 'linux'
    ? setTimeout(() => void stop(), ORCAD_SHUTDOWN_DEADLINE_MS * 2)
    : undefined

function stop(): Promise<void> {
  stopping ??= (async () => {
    const deadline = setTimeout(() => process.exit(1), ORCAD_SHUTDOWN_DEADLINE_MS)
    abort.abort(new Error('Backend is stopping.'))
    documents.closeAll()
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
  // Room for an orphaned holder to notice its desktop is gone and finish stopping.
  const ownerWatchSlack = process.platform === 'linux' ? 2 * DESKTOP_OWNER_POLL_MS : 0
  const deadline = Date.now() + ORCAD_SHUTDOWN_DEADLINE_MS + ownerWatchSlack
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
  clearTimeout(bootstrapDeadline)
  const config = BackendBootstrapSchema.parse(raw)
  if (
    config.requiredCapabilities.some(
      (capability) => !BACKEND_CAPABILITIES.some((offered) => offered === capability)
    )
  ) {
    throw new Error('Backend contract is unsupported.')
  }
  await watchDesktopOwner(config.desktopOwner, () => {
    console.error(`[backend ${incarnation}] Desktop process is gone; stopping.`)
    void stop()
  })
  abort.signal.throwIfAborted()
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
      // Paired clients reach usage through main's runtime RPC, with a renderer's privileges.
      if (method === BACKEND_PUBLIC_USAGE_METHOD) {
        const call = UsageCallParams.parse(params)
        return usage.invoke(call.method, call.params, false, signal)
      }
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
        // Stopping cancels reads main is still serving instead of holding shutdown on them.
        return control!.call(method, params, abort.signal)
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
          capture: async (totals) =>
            (await call(
              'usage.telemetry.captureDaily',
              agentTokenUsageDailySchema.parse(totals)
            )) === true
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
  const message = event.data as { type?: unknown; config?: unknown; document?: unknown }
  const [port, ...surplus] = event.ports
  for (const extra of surplus) {
    extra.close()
  }
  if (message?.type === 'bootstrap' && port) {
    startup = bootstrap(message.config, port)
    void startup.catch((error: unknown) => {
      const code = error instanceof Error && 'code' in error ? ` (${String(error.code)})` : ''
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`[backend ${incarnation}] Startup failed: ${reason}${code}`)
      parent!.postMessage({ type: 'failed', incarnation })
      void stop()
    })
    return
  }
  if (message?.type === 'retire' && typeof message.document === 'string') {
    documents.retire(message.document)
    port?.close()
    return
  }
  if (message?.type === 'client' && port && usage && !stopping) {
    documents.admit(message, backendMessagePort(port))
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
