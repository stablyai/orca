import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  CROSS_MACHINE_RECOVERY_DESCRIBE_PROTOCOL,
  type RecoveryDescribeResult
} from '../../../../shared/cross-machine-recovery-descriptor'
import { pairedDevicePresentationClientKey } from '../../../../shared/cross-machine-recovery-presentation-types'
import {
  CrossMachineRecoveryActivityParams,
  CrossMachineRecoveryDescribeParams,
  CrossMachineRecoveryExportParams,
  CrossMachineRecoveryImportParams,
  CrossMachineRecoveryListParams,
  CrossMachineRecoveryPresentationPublishParams,
  CrossMachineRecoveryResumeParams
} from '../../../../shared/rpc-contract/cross-machine-recovery-params'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { readOrMintCrossMachineRecoveryClientInstanceId } from '../../cross-machine-recovery/client-instance-id'
import { getCrossMachineRecoveryPresentationStore } from '../../cross-machine-recovery/presentation-store-instance'
import { readRecoveryActivity } from '../../cross-machine-recovery/recovery-activity'
import { exportRecoveryWorkspace } from '../../cross-machine-recovery/recovery-export'
import { importRecoveryWorkspace } from '../../cross-machine-recovery/recovery-import'
import { listRecoveryBindings } from '../../cross-machine-recovery/recovery-list'
import { resumeRecoveryBinding } from '../../cross-machine-recovery/recovery-resume'
import { getRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { defineMethod, type RpcContext } from '../core'

// Why: recovery reads and writes this machine's own workspaces; a paired device or runtime
// peer must never import into, or export from, a host it is only visiting.
function assertLocalRecoveryCaller(ctx: RpcContext): void {
  if (ctx.clientKind === 'mobile' || ctx.clientKind === 'runtime' || ctx.pairedDeviceId) {
    throw new Error('recovery_local_only')
  }
}

export const CROSS_MACHINE_RECOVERY_METHODS = [
  defineMethod({
    name: 'crossMachineRecovery.describe',
    params: CrossMachineRecoveryDescribeParams,
    handler: async (_params, ctx): Promise<RecoveryDescribeResult> => {
      assertLocalRecoveryCaller(ctx)
      const hostKind = getRuntimeDesktopSurface().servesDesktopRenderer?.() ? 'desktop' : 'headless'
      return {
        protocol: CROSS_MACHINE_RECOVERY_DESCRIBE_PROTOCOL,
        runtimeId: ctx.runtime.getRuntimeId(),
        executionHostId: 'local',
        appVersion: getAppEnvironment().getVersion(),
        platform: process.platform,
        machineName: ctx.runtime.readMachineName(),
        hostKind,
        localClientInstanceId:
          hostKind === 'desktop'
            ? await readOrMintCrossMachineRecoveryClientInstanceId(getProfileUserDataPath())
            : null,
        capabilities: ctx.runtime.getStatus().capabilities ?? []
      }
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.export',
    params: CrossMachineRecoveryExportParams,
    handler: async (params, ctx) => {
      assertLocalRecoveryCaller(ctx)
      return await exportRecoveryWorkspace(ctx.runtime, params.worktree, Date.now())
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.import',
    params: CrossMachineRecoveryImportParams,
    handler: async (params, ctx) => {
      assertLocalRecoveryCaller(ctx)
      return await importRecoveryWorkspace(ctx.runtime, params)
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.resume',
    params: CrossMachineRecoveryResumeParams,
    handler: async (params, ctx) => {
      assertLocalRecoveryCaller(ctx)
      return await resumeRecoveryBinding(ctx.runtime, params)
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.list',
    params: CrossMachineRecoveryListParams,
    handler: async (params, ctx) => {
      assertLocalRecoveryCaller(ctx)
      return await listRecoveryBindings(ctx.runtime, params.worktree)
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.activity',
    params: CrossMachineRecoveryActivityParams,
    handler: async (_params, ctx) => {
      assertLocalRecoveryCaller(ctx)
      return await readRecoveryActivity(ctx.runtime, Date.now())
    }
  }),
  defineMethod({
    name: 'crossMachineRecovery.presentation.publish',
    params: CrossMachineRecoveryPresentationPublishParams,
    handler: async (params, ctx) => {
      // Why: the key comes from the authenticated device, never the payload, so the unix-socket
      // CLI cannot impersonate a paired client and one device cannot overwrite another's views.
      if (!ctx.pairedDeviceId) {
        throw new Error('recovery_unsupported')
      }
      return await getCrossMachineRecoveryPresentationStore().record(
        pairedDevicePresentationClientKey(ctx.pairedDeviceId),
        'paired-device',
        params,
        Date.now()
      )
    }
  })
]
