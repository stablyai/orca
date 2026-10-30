import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getPublishedHostDescriptor } from '../../host-descriptor'

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId }) => {
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
