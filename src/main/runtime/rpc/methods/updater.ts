import { defineMethod } from '../core'
import {
  checkRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater
} from '../../remote-server-updater'
import { UpdaterCheckParams } from '../../../../shared/rpc-contract/updater-params'

export const UPDATER_METHODS = [
  defineMethod({
    name: 'updater.getStatus',
    params: null,
    handler: (_params, { runtime }) => getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.check',
    params: UpdaterCheckParams,
    handler: (params, { runtime }) => checkRemoteServerUpdater(runtime.getRuntimeId(), params)
  }),
  defineMethod({
    name: 'updater.download',
    params: null,
    handler: (_params, { runtime }) => downloadRemoteServerUpdater(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.install',
    params: null,
    handler: (_params, { runtime }) => installRemoteServerUpdater(runtime.getRuntimeId())
  })
]
