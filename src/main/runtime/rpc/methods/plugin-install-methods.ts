import { hostname } from 'node:os'
import { defineMethod, type RpcContext } from '../core'
import {
  PluginCatalogAddParams,
  PluginCatalogRemoveParams,
  PluginInstallParams,
  PluginUninstallParams,
  PluginUpdateParams
} from '../../../../shared/rpc-contract/plugins-params'
import {
  PLUGIN_NOT_FOUND_CODE,
  PluginCliError
} from '../../../../shared/plugins/approval/plugin-cli-approval'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PluginConsentRequest } from '../../../../shared/plugins/approval/plugin-consent-request'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import { listPluginsForClients } from '../../../plugins/plugin-client-list'
import type { PluginService } from '../../../plugins/plugin-service'
import type { PluginCliCatalogs } from '../../../plugins/plugin-cli-catalog-candidates'
import {
  installPluginFromCli,
  type PluginCliInstallDeps
} from '../../../plugins/plugin-cli-install'
import {
  updateAllApprovalError,
  updateAllPluginsFromCli,
  updatePluginFromCli
} from '../../../plugins/plugin-cli-update'
import {
  addPluginCatalogFromCli,
  listPluginCatalogsFromCli,
  removePluginCatalogFromCli
} from '../../../plugins/plugin-cli-catalogs'
import { uninstallInstalledPlugin } from '../../../plugins/installation/plugin-uninstall'
import { assertPluginSystemEnabled } from '../../../plugins/plugin-dev-folders'

/** What install, update, uninstall and catalog RPCs need beyond the plugin service. */
export type PluginInstallRpcServices = {
  pluginService: PluginService
  catalogs: PluginCliCatalogs
  applyConsent: (request: PluginConsentRequest) => Promise<void>
  getSettings: () => GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => void
}

let installServicesForRpc: PluginInstallRpcServices | null = null

export function setPluginInstallServicesForRpc(services: PluginInstallRpcServices | null): void {
  installServicesForRpc = services
}

async function requireInstallServices(): Promise<PluginInstallRpcServices> {
  if (!installServicesForRpc) {
    throw new Error('Plugin installs are not available on this runtime')
  }
  await installServicesForRpc.pluginService.whenReady()
  return installServicesForRpc
}

function installDeps(
  services: PluginInstallRpcServices,
  context: RpcContext
): PluginCliInstallDeps {
  return {
    service: services.pluginService,
    catalogs: services.catalogs,
    applyConsent: services.applyConsent,
    // Why the hostname: a credential fix must happen on the machine whose Git ran.
    executionHost: `the Orca host (${hostname()})`,
    caller: context.caller
  }
}

async function listEntry(
  service: PluginService,
  pluginKey: string
): Promise<PluginHostListEntry | null> {
  return (
    (await listPluginsForClients(service)).find((entry) => entry.pluginKey === pluginKey) ?? null
  )
}

export const PLUGIN_INSTALL_METHODS = [
  defineMethod({
    // Git runs on this host with its own credentials and no prompts; code needs the approve flag.
    name: 'plugins.install',
    permission: 'host-admin',
    params: PluginInstallParams,
    handler: async (params, context) => {
      const services = await requireInstallServices()
      const outcome = await installPluginFromCli(
        installDeps(services, context),
        params.source,
        params.approvalFingerprint
      )
      return { ...outcome, plugin: await listEntry(services.pluginService, outcome.pluginKey) }
    }
  }),
  defineMethod({
    name: 'plugins.update',
    permission: 'host-admin',
    params: PluginUpdateParams,
    handler: async (params, context) => {
      const services = await requireInstallServices()
      const deps = installDeps(services, context)
      if (params.pluginKey === undefined) {
        const result = await updateAllPluginsFromCli(deps)
        const approval = updateAllApprovalError(result)
        if (approval) {
          throw approval
        }
        return result
      }
      return updatePluginFromCli(deps, params.pluginKey, params.approvalFingerprint)
    }
  }),
  defineMethod({
    name: 'plugins.uninstall',
    permission: 'host-admin',
    params: PluginUninstallParams,
    handler: async (params) => {
      const services = await requireInstallServices()
      assertPluginSystemEnabled(services.pluginService)
      const removed = await uninstallInstalledPlugin({
        pluginService: services.pluginService,
        getSettings: services.getSettings,
        updateSettings: services.updateSettings,
        pluginKey: params.pluginKey
      })
      if (!removed) {
        throw new PluginCliError(
          PLUGIN_NOT_FOUND_CODE,
          `${params.pluginKey} is not an installed plugin that can be removed.`,
          {
            pluginKey: params.pluginKey,
            nextSteps: [
              'Plugins bundled with Orca cannot be removed; disable them with `orca plugin disable`.',
              'Remove a development folder with `orca plugin dev unload`.'
            ]
          }
        )
      }
      return { pluginKey: params.pluginKey, removed: true }
    }
  }),
  defineMethod({
    name: 'plugins.catalogList',
    permission: 'host-admin',
    params: null,
    handler: async () => {
      const services = await requireInstallServices()
      return listPluginCatalogsFromCli(catalogDeps(services))
    }
  }),
  defineMethod({
    name: 'plugins.catalogAdd',
    permission: 'host-admin',
    params: PluginCatalogAddParams,
    handler: async (params) => {
      const services = await requireInstallServices()
      return addPluginCatalogFromCli(catalogDeps(services), params)
    }
  }),
  defineMethod({
    name: 'plugins.catalogRemove',
    permission: 'host-admin',
    params: PluginCatalogRemoveParams,
    handler: async (params) => {
      const services = await requireInstallServices()
      return removePluginCatalogFromCli(catalogDeps(services), params.catalog)
    }
  })
]

function catalogDeps(services: PluginInstallRpcServices) {
  return {
    catalogs: services.catalogs,
    host: { executionHost: `the Orca host (${hostname()})` },
    service: services.pluginService
  }
}
