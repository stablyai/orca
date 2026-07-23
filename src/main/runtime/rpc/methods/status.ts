import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
