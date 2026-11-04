import { defineMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { getPublishedHostDescriptor } from '../../host-descriptor'
import { StatusGetParams } from '../../../../shared/rpc-contract/status-params'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { prewarmAiVaultSessionListCache } from '../../../ai-vault/cached-session-list'
import { readHostMachineWithin } from '../../runtime-host-machine'
import { MACHINE_NAME_PUBLISH_WAIT_MS } from '../../runtime-machine-name'

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
      // Hardware shares that bound; a slow first probe omits hostMachine until a later read.
      const [, hostMachine] = await Promise.all([
        runtime.machineNameReady(),
        readHostMachineWithin(MACHINE_NAME_PUBLISH_WAIT_MS)
      ])
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      const hostDescriptor = getPublishedHostDescriptor(runtime.getRuntimeId())
      const status = runtime.getStatus()
      let activePath: string | undefined
      try {
        const lastActiveId = runtime.getUIState?.().lastActiveWorktreeId
        activePath = lastActiveId
          ? splitWorktreeIdForFilesystem(lastActiveId)?.worktreePath
          : undefined
      } catch {
        // Store may be uninitialized in minimal runtime test stubs.
      }
      prewarmAiVaultSessionListCache(activePath ? [activePath] : undefined)
      return {
        ...status,
        ...(hostDescriptor ? { hostDescriptor } : {}),
        ...(hostMachine ? { hostMachine } : {}),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  })
]
