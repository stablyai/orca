import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getPublishedHostDescriptor } from '../../host-descriptor'
import { StatusGetParams } from '../../../../shared/rpc-contract/status-params'

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    permission: 'workspace',
    params: StatusGetParams,
    handler: async (params, { runtime, pairedDeviceId }) => {
      // Why: a liveness probe needs only an answer; the full status is ~12 KB on every idle probe.
      if (params.probe === true) {
        return { runtimeId: runtime.getRuntimeId() }
      }
      // Bound friendly-name waiting below the CLI status timeout; slow lookup falls back to hostname, never host-down.
      await runtime.machineNameReady()
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      const hostDescriptor = getPublishedHostDescriptor(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(hostDescriptor ? { hostDescriptor } : {}),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
