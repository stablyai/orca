import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import {
  GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'

const INDEX_PRESERVING_DISCARD_METHODS = [
  'git.discardFromIndex',
  'git.bulkDiscardFromIndex'
] as const

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, registeredMethods }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      const status = runtime.getStatus()
      const capabilities = [...(status.capabilities ?? [])]
      if (
        registeredMethods &&
        INDEX_PRESERVING_DISCARD_METHODS.every((method) => registeredMethods.has(method))
      ) {
        capabilities.push(GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY)
      }
      if (registeredMethods?.has('git.bulkDiscardStaged')) {
        capabilities.push(GIT_STAGED_DISCARD_RUNTIME_CAPABILITY)
      }
      return {
        ...status,
        capabilities,
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
