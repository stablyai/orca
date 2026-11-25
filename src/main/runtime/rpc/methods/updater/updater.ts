import { defineMethod } from '../../core'
import {
  checkRemoteServerUpdater,
  downloadRemoteServerUpdater,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdater
} from '../../../hosts/management/remote-server-updater'
import { UpdaterCheckParams } from '../../../../../shared/rpc-contract/updater/updater-params'

export const UPDATER_METHODS = [
  defineMethod({
    name: 'updater.getStatus',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.check',
    permission: 'host-admin',
    share: 'not-shared',
    params: UpdaterCheckParams,
    handler: (params, { runtime }) => checkRemoteServerUpdater(runtime.getRuntimeId(), params)
  }),
  defineMethod({
    name: 'updater.download',
    permission: 'host-admin',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => downloadRemoteServerUpdater(runtime.getRuntimeId())
  }),
  defineMethod({
    name: 'updater.install',
    permission: 'host-admin',
    share: 'not-shared',
    params: null,
    handler: (_params, { runtime }) => installRemoteServerUpdater(runtime.getRuntimeId())
  })
]
