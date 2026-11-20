import type {
  WslHostAddResult,
  WslHostCapability,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import {
  WslHostAddParams,
  WslHostConnectParams,
  WslHostEnvironmentParams,
  WslHostVisibleWorkParams
} from '../../../../shared/rpc-contract/wsl-host-params'
import { getWslHostService } from '../../../wsl/host-lifecycle/wsl-host-service-instance'
import { defineMethod } from '../core'

function requireWslHostService() {
  const service = getWslHostService()
  if (!service) {
    throw new Error('WSL hosts are not available in this runtime.')
  }
  return service
}

export const WSL_HOST_METHODS = [
  defineMethod({
    name: 'wslHosts.getCapability',
    permission: 'workspace',
    params: null,
    handler: (): WslHostCapability => ({ serverFiles: requireWslHostService().hasServerFiles() })
  }),
  defineMethod({
    name: 'wslHosts.listDistros',
    permission: 'workspace',
    params: null,
    handler: (): Promise<WslHostDistro[]> => requireWslHostService().listDistros()
  }),
  defineMethod({
    name: 'wslHosts.add',
    permission: 'host-admin',
    params: WslHostAddParams,
    handler: (params): Promise<WslHostAddResult> => requireWslHostService().add(params)
  }),
  defineMethod({
    name: 'wslHosts.remove',
    permission: 'host-admin',
    params: WslHostEnvironmentParams,
    handler: (params): Promise<WslHostServerStop> =>
      requireWslHostService().remove(params.environmentId)
  }),
  defineMethod({
    name: 'wslHosts.connect',
    permission: 'host-admin',
    params: WslHostConnectParams,
    handler: async (params): Promise<void> => {
      await requireWslHostService().connect(params.environmentId, {
        intent: params.intent ?? (params.force === true ? 'force' : undefined)
      })
    }
  }),
  defineMethod({
    name: 'wslHosts.getStatuses',
    permission: 'workspace',
    params: null,
    handler: (): WslHostStatus[] => requireWslHostService().getStatuses()
  }),
  defineMethod({
    name: 'wslHosts.setVisibleWork',
    permission: 'workspace',
    params: WslHostVisibleWorkParams,
    handler: (params): void => {
      requireWslHostService().setVisibleWork(params.environmentIds)
    }
  })
]
