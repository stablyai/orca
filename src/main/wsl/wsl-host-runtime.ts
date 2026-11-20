import type { Store } from '../persistence/loading-store/store'
import { hasOrcadTemplate } from '../orcad/artifact-slots/orcad-artifact-materializer'
import { retireRemovedRuntimeEnvironment } from '../ipc/runtime-environments/catalog/runtime-environment-removal-cleanup'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environments/status/runtime-environment-status-probe'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { WslHostStatus } from '../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { requestOrcadTerminalCensus } from '../managed-server/lifecycle/orcad-terminal-census-client'
import type { WslHostRuntimeAccess } from './host-lifecycle/wsl-host-server-stop'
import {
  changesWslHostAccounts,
  pushWslOrcadHostAccountEnv
} from './orcad/wsl-orcad-host-account-push'
import { wslOrcadHostSupports } from './orcad/wsl-orcad-host-environments'
import { createWslHostConnector } from './host-lifecycle/wsl-host-connector'
import {
  createFakeWslHostConnector,
  readFakeWslHostsConfig
} from './host-lifecycle/wsl-host-e2e-fake-connector'
import { WslHostService } from './host-lifecycle/wsl-host-service'
import { wslHostsGateOpen } from './host-lifecycle/wsl-host-gate'
import { getWslHostService, setWslHostService } from './host-lifecycle/wsl-host-service-instance'

export type WslHostRuntimeOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
  publish: (status: WslHostStatus) => void
}

function createRuntimeAccess(getUserDataPath: () => string): WslHostRuntimeAccess {
  return {
    call: async (environmentId, method, params) => {
      const response = await callRuntimeEnvironment(
        getUserDataPath(),
        environmentId,
        method,
        params
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    },
    census: async (environmentId) =>
      requestOrcadTerminalCensus(
        getPreferredPairedRuntimeConnection(
          await resolveEnvironment(getUserDataPath(), environmentId)
        ),
        0
      )
  }
}

function createService(args: WslHostRuntimeOptions): WslHostService | null {
  if (!wslHostsGateOpen()) {
    return null
  }
  const fake = readFakeWslHostsConfig()
  if (process.platform !== 'win32' && !fake) {
    return null
  }
  let service: WslHostService
  service = new WslHostService({
    userDataPath: args.getUserDataPath,
    isEnabled: () => args.store.getSettings().experimentalWslHosts === true,
    hasServerFiles: fake ? () => fake.serverFiles !== 'missing' : hasOrcadTemplate,
    publish: args.publish,
    pairingChanged: (environmentId) => void args.invalidateTransport(environmentId),
    ready: (environmentId) => {
      void getRuntimeEnvironmentStatus(args.getUserDataPath(), environmentId, undefined, {
        reconnect: true
      }).catch(() => {})
      void service.recordForEnvironment(environmentId).then((record) => {
        const distro = record?.distro
        if (distro) {
          const call = (method: string, params: unknown) =>
            callRuntimeEnvironment(args.getUserDataPath(), environmentId, method, params)
          void pushWslOrcadHostAccountEnv({
            environmentId,
            distro,
            call,
            hostSupports: (capability) =>
              wslOrcadHostSupports(environmentId, capability, () => call('status.get', undefined))
          })
        }
      })
    },
    removed: (environmentId) =>
      retireRemovedRuntimeEnvironment(environmentId, args.invalidateTransport, args.store)
  })
  const onChange = service.handleConnectionChange.bind(service)
  const isKnownDistro = (distro: string): Promise<boolean> => service.isKnownDistro(distro)
  const runtime = createRuntimeAccess(args.getUserDataPath)
  service.attach(
    fake
      ? createFakeWslHostConnector(fake, onChange, { isKnownDistro, runtime })
      : createWslHostConnector({
          userDataPath: args.getUserDataPath(),
          onChange,
          hasUserVisibleWork: (distro) => service.hasUserVisibleWork(distro),
          isKnownDistro,
          runtime
        })
  )
  return service
}

const settingsCleanup = new WeakMap<WslHostService, () => void>()

/** Starts the WSL host service for either Electron or the Node-owned Tauri runtime. */
export function startWslHostRuntime(args: WslHostRuntimeOptions): WslHostService | null {
  const existing = getWslHostService()
  if (existing) {
    return existing
  }
  const service = createService(args)
  if (!service) {
    return null
  }
  setWslHostService(service)
  const unsubscribeSettings = args.store.onSettingsChanged((updates, settings) => {
    if (changesWslHostAccounts(updates)) {
      for (const status of service.getStatuses()) {
        if (status.state !== 'ready') {
          continue
        }
        void service.recordForEnvironment(status.environmentId).then((record) => {
          const distro = record?.distro
          if (distro) {
            const call = (method: string, params: unknown) =>
              callRuntimeEnvironment(args.getUserDataPath(), status.environmentId, method, params)
            void pushWslOrcadHostAccountEnv({
              environmentId: status.environmentId,
              distro,
              call,
              hostSupports: (capability) =>
                wslOrcadHostSupports(status.environmentId, capability, () =>
                  call('status.get', undefined)
                )
            })
          }
        })
      }
    }
    if ('experimentalWslHosts' in updates) {
      void service.enabledChanged(settings.experimentalWslHosts === true).catch((error) => {
        console.warn('[wsl-hosts] Could not apply the WSL hosts setting:', error)
      })
    }
  })
  settingsCleanup.set(service, unsubscribeSettings)
  void service.start().catch((error: unknown) => {
    console.warn('[wsl-hosts] Could not adopt WSL distro holders:', error)
  })
  return service
}

export async function stopWslHostRuntime(service: WslHostService): Promise<void> {
  settingsCleanup.get(service)?.()
  settingsCleanup.delete(service)
  await service.dispose()
  if (getWslHostService() === service) {
    setWslHostService(null)
  }
}
