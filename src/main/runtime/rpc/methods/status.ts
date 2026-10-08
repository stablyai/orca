import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

export const STATUS_METHODS = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId }) => {
      // Why: a status answered while the friendly-name lookup is still in flight publishes the bare
      // hostname; the wait is capped below the CLI's status probe so a slow lookup never reads as down.
      await runtime.machineNameReady()
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
