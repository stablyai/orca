import { removeEnvironment } from '../../shared/runtime-environment-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { OrcadManagedStopResult } from '../../shared/orcad-managed-runtime'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { closeOrcadManagedTunnel, ensureOrcadManagedTunnel } from './orcad-managed-tunnel'
import type { OrcadRemoteContext } from './orcad-remote-context'
import { stopRemoteOrcad } from './orcad-remote-stop'
import {
  requestRemoteOrcadDecommission,
  readRemoteOrcadManagedStopIdentity,
  requestRemoteOrcadManagedDecommission
} from './orcad-decommission-client'
import {
  requireManagedOrcadEnvironment,
  requireManagedOrcadInfrastructure,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'

export async function stopManagedOrcadEnvironment(
  userDataPath: string,
  args: { selector: string; signal?: AbortSignal },
  options: {
    invalidateTransport: (environmentId: string) => Promise<void> | void
    cleanupLocalState?: (environmentId: string) => Promise<void> | void
    isActiveEnvironment: (environmentId: string) => boolean
  }
): Promise<OrcadManagedStopResult> {
  const environment = requireManagedOrcadEnvironment(userDataPath, args.selector)
  const deployment = environment.orcadDeployment!
  const assertDecommissionAllowed = () => {
    assertRuntimeEnvironmentNotReconciling(
      requireManagedOrcadEnvironment(userDataPath, environment.id)
    )
    if (options.isActiveEnvironment(environment.id)) {
      throw new Error('Choose another Active Server in Advanced before stopping this server.')
    }
  }
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    let context: OrcadRemoteContext
    try {
      assertDecommissionAllowed()
      context = await resolveLinkedOrcadContext(environment, args.signal)
    } catch (error) {
      return unverifiableStopFailure('orcad_stop_connection_unverifiable', error)
    }

    let stopped: Awaited<ReturnType<typeof stopRemoteOrcad>>
    try {
      assertDecommissionAllowed()
      stopped = await stopRemoteOrcad({
        assertDecommissionAllowed,
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        record: context.activationRecord,
        requestDecommission: (activeVersion, transactionId) => {
          assertDecommissionAllowed()
          return requestRemoteOrcadDecommission(environment, activeVersion, transactionId)
        },
        managedStop: {
          runtimeId: environment.runtimeId ?? '',
          readIdentity: async (version) => {
            await ensureOrcadManagedTunnel(userDataPath, environment.id)
            assertDecommissionAllowed()
            return readRemoteOrcadManagedStopIdentity(environment, version)
          },
          requestDecommission: (version, authority) => {
            assertDecommissionAllowed()
            return requestRemoteOrcadManagedDecommission(environment, version, authority)
          }
        },
        signal: args.signal
      })
    } catch (error) {
      return unverifiableStopFailure('orcad_stop_process_unverifiable', error, 'failed')
    }
    if (stopped.outcome === 'refused') {
      return stopped
    }
    if (options.isActiveEnvironment(environment.id)) {
      return activeEnvironmentChangedDuringStop()
    }

    try {
      await closeOrcadManagedTunnel(environment.id)
      await options.invalidateTransport(environment.id)
      await options.cleanupLocalState?.(environment.id)
      // No await after this check: preference changes cannot interleave with release/removal.
      if (options.isActiveEnvironment(environment.id)) {
        return activeEnvironmentChangedDuringStop()
      }
      const targetStore = requireManagedOrcadInfrastructure().targetStore
      const released = targetStore.releaseOrcadRuntimeTarget(deployment.sshTargetId, environment.id)
      if (!released) {
        return {
          outcome: 'failed',
          verdict: 'exited',
          code: 'orcad_unlink_target_release_failed',
          reason:
            'orcad exited, but its SSH target ownership could not be released. The managed server remains linked.'
        }
      }
      let removed: KnownRuntimeEnvironment
      try {
        removed = removeEnvironment(userDataPath, environment.id)
      } catch (error) {
        targetStore.claimOrcadRuntimeTarget(deployment.sshTargetId, environment.id)
        throw error
      }
      return {
        outcome: 'unlinked',
        verdict: 'exited',
        environment: redactRuntimeEnvironment(removed),
        sshTargetId: deployment.sshTargetId,
        activeVersion: stopped.activeVersion
      }
    } catch (error) {
      return {
        outcome: 'failed',
        verdict: 'exited',
        code: 'orcad_unlink_local_cleanup_failed',
        reason:
          `orcad exited, but local unlink cleanup did not finish: ${errorMessage(error)} ` +
          'Retry Stop and unlink to finish cleanup.'
      }
    }
  })
}

function activeEnvironmentChangedDuringStop(): OrcadManagedStopResult {
  return {
    outcome: 'failed',
    verdict: 'exited',
    code: 'orcad_unlink_became_active',
    reason:
      'orcad exited, but this server became the Active Server while it was stopping. ' +
      'Choose another Active Server, then retry Stop and unlink to finish local cleanup.'
  }
}

function unverifiableStopFailure(
  code: string,
  error: unknown,
  outcome: 'refused' | 'failed' = 'refused'
): OrcadManagedStopResult {
  return {
    outcome,
    verdict: 'unverifiable',
    code,
    reason:
      `The host could not verify that orcad exited: ${errorMessage(error)} ` +
      'The managed server remains linked.'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
