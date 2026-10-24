import {
  RuntimeSshAccessLinkRequestSchema,
  RuntimeSshAccessUnlinkRequestSchema,
  type RuntimeSshAccessLinkRequest,
  type RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { assertRuntimeEnvironmentNotReconciling } from '../../shared/runtime-environment-reconciliation-record'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  cancelRuntimeEnvironmentSshAccessLink,
  completeRuntimeEnvironmentSshAccessUnlink,
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink,
  prepareRuntimeEnvironmentSshAccessUnlink
} from '../../shared/runtime-environment-ssh-access-store'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { runTargetLifecycle } from '../ipc/ssh/ssh-target-lifecycle-queue'
import { requireManagedOrcadInfrastructure } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import {
  closeOrcadManagedTunnel,
  ensureOrcadManagedTunnel,
  startOrcadManagedTunnel
} from '../managed-server/lifecycle/orcad-managed-tunnel'
import { verifyRuntimeEnvironmentSshTunnel } from './runtime-ssh-access-verification'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-target-fingerprint'
import { orcadTargetBlockerMessage } from './targets/ssh-target-orcad-claims'
import { dependentStateSummary } from './targets/ssh-target-orcad-dependents'
import type { OrcadMigrationBlocker } from '../../shared/orcad-migration/orcad-migration-preflight'

type TargetClaims = ReturnType<typeof requireManagedOrcadInfrastructure>['claims']

function requireTarget(claims: TargetClaims, targetId: string): SshTarget & { generation: number } {
  const target = claims.listTargets().find((entry) => entry.id === targetId)
  const generation = target?.generation
  if (!target || generation === undefined || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('SSH access requires an existing durable SSH target generation.')
  }
  if (target.orcadProvisioning) {
    throw new Error('This SSH target has pending server provisioning.')
  }
  return { ...target, generation }
}

// Why: the code alone gave users nothing to act on, and the host-conversion copy does not fit a link.
function sshAccessBlockerMessage(targetId: string, blocker: OrcadMigrationBlocker): string {
  switch (blocker.code) {
    case 'orcad_migration_dependent_state':
      return `This SSH target is still used by saved Orca state: ${dependentStateSummary(blocker.dependencies)}. Remove it, or link SSH access through an SSH target with nothing saved.`
    case 'orcad_migration_direct_ssh_repositories':
    case 'orcad_migration_direct_ssh_folder_workspaces':
      return 'This SSH target already has direct SSH projects. Remove them, or link SSH access through another SSH target.'
    case 'orcad_migration_direct_ssh_terminal_leases':
      return 'This SSH target still owns terminal sessions. Close them before linking SSH access.'
    case 'orcad_migration_saved_port_forwards':
      return 'This SSH target has saved port forwards. Remove them, or link SSH access through another SSH target.'
    case 'orcad_migration_target_not_found':
    case 'orcad_migration_target_owned':
    case 'orcad_migration_owner_unrecorded':
    case 'orcad_migration_dependency_unverifiable':
      return orcadTargetBlockerMessage(targetId, blocker)
  }
}

function requireAccessOnlyTarget(claims: TargetClaims, targetId: string, environmentId: string) {
  const target = requireTarget(claims, targetId)
  // Omitting the environment bypasses the same-owner shortcut and rechecks direct authority.
  const blockers = claims
    .preflight(targetId)
    .blockers.filter(
      (entry) =>
        !(
          entry.code === 'orcad_migration_target_owned' &&
          getManagedOrcadFenceEnvironmentId(target) === environmentId
        )
    )
  if (blockers.length) {
    throw new Error(
      `SSH access cannot claim direct SSH authority: ${blockers[0].code}. ${sshAccessBlockerMessage(targetId, blockers[0])}`
    )
  }
  return target
}

function requireFence(
  claims: TargetClaims,
  environmentId: string,
  fence: {
    sshTargetId: string
    sshTargetGeneration: number
    targetFingerprint?: string
  },
  allowUnowned = false
): SshTarget {
  const target = requireTarget(claims, fence.sshTargetId)
  const owner = getManagedOrcadFenceEnvironmentId(target)
  if (
    target.generation !== fence.sshTargetGeneration ||
    !fence.targetFingerprint ||
    fingerprintRuntimeSshTarget(target) !== fence.targetFingerprint ||
    (owner !== environmentId && !(allowUnowned && !target.orcadFence))
  ) {
    throw new Error('The SSH target registration, connection configuration, or owner changed.')
  }
  return target
}

export function linkRuntimeSshAccess(
  userDataPath: string,
  input: RuntimeSshAccessLinkRequest,
  options: {
    signal?: AbortSignal
    invalidateTransport?: (environmentId: string) => void | Promise<void>
  } = {}
) {
  const args = RuntimeSshAccessLinkRequestSchema.parse(input)
  const environmentId = resolveEnvironment(userDataPath, args.selector).id
  return runTargetLifecycle(`runtime-ssh-access:${userDataPath}:${environmentId}`, () =>
    runTargetLifecycle(args.sshTargetId, async () => {
      const { claims, connectionManager } = requireManagedOrcadInfrastructure()
      const environment = resolveEnvironment(userDataPath, environmentId)
      assertRuntimeEnvironmentNotReconciling(environment)
      if (environment.orcadDeployment) {
        throw new Error('Managed deployments cannot use independent SSH access.')
      }
      const target = requireAccessOnlyTarget(claims, args.sshTargetId, environmentId)
      const fence = {
        sshTargetId: target.id,
        sshTargetGeneration: target.generation,
        targetFingerprint: fingerprintRuntimeSshTarget(target)
      }
      if (environment.sshAccess) {
        const access = environment.sshAccess
        if (
          environment.pendingSshAccessOperation ||
          access.requestId !== args.requestId ||
          access.sshTargetId !== args.sshTargetId ||
          access.remotePort !== args.remotePort
        ) {
          throw new Error('This server already has a different SSH access request.')
        }
        requireFence(claims, environmentId, access)
        await ensureOrcadManagedTunnel(userDataPath, environmentId)
        requireFence(claims, environmentId, access)
        await options.invalidateTransport?.(environmentId)
        return redactRuntimeEnvironment(resolveEnvironment(userDataPath, environmentId))
      }
      const prepared = prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: environment,
        requestId: args.requestId,
        remotePort: args.remotePort,
        ...fence
      })
      await claims.flush()
      requireAccessOnlyTarget(claims, target.id, environmentId)
      requireFence(claims, environmentId, fence, true)
      // Why recorded: the durable link intent above names this target and environment.
      claims.claim(target.id, environmentId, { ownerRecorded: true })
      await claims.flush()
      let tunnelStarted = false
      let linkCommitted = false
      try {
        options.signal?.throwIfAborted()
        const claimed = requireFence(claims, environmentId, fence)
        // A cancel drops the pending connect, which frees both lifecycle queues behind it.
        const cancelConnect = (): void =>
          void connectionManager.disconnect(claimed.id).catch(() => {})
        options.signal?.addEventListener('abort', cancelConnect, { once: true })
        const connection = await connectionManager
          .connect(claimed)
          .finally(() => options.signal?.removeEventListener('abort', cancelConnect))
        options.signal?.throwIfAborted()
        requireFence(claims, environmentId, fence)
        tunnelStarted = true
        const localPort = await startOrcadManagedTunnel(
          environmentId,
          claimed,
          connection,
          args.remotePort
        )
        const proof = await verifyRuntimeEnvironmentSshTunnel(prepared, localPort, options.signal)
        options.signal?.throwIfAborted()
        requireAccessOnlyTarget(claims, target.id, environmentId)
        requireFence(claims, environmentId, fence)
        const linked = redactRuntimeEnvironment(
          linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
            expectedEnvironment: prepared,
            requestId: args.requestId,
            ...proof,
            tunnel: {
              sshTargetId: target.id,
              sshTargetGeneration: fence.sshTargetGeneration,
              localPort,
              remotePort: args.remotePort
            }
          })
        )
        linkCommitted = true
        await options.invalidateTransport?.(environmentId)
        return linked
      } catch (error) {
        if (tunnelStarted && !linkCommitted) {
          await closeOrcadManagedTunnel(environmentId)
        }
        throw error
      }
    })
  )
}

export function unlinkRuntimeSshAccess(
  userDataPath: string,
  input: RuntimeSshAccessUnlinkRequest,
  options: { invalidateTransport: (environmentId: string) => void | Promise<void> }
) {
  const args = RuntimeSshAccessUnlinkRequestSchema.parse(input)
  const environmentId = resolveEnvironment(userDataPath, args.selector).id
  return runTargetLifecycle(`runtime-ssh-access:${userDataPath}:${environmentId}`, async () => {
    const environment = resolveEnvironment(userDataPath, environmentId)
    assertRuntimeEnvironmentNotReconciling(environment)
    if (environment.orcadDeployment) {
      throw new Error('Managed deployments cannot unlink independent SSH access.')
    }
    const access = environment.pendingSshAccessOperation ?? environment.sshAccess
    if (!access) {
      return redactRuntimeEnvironment(environment)
    }
    return runTargetLifecycle(access.sshTargetId, async () => {
      const { claims } = requireManagedOrcadInfrastructure()
      requireFence(claims, environmentId, access, !!environment.pendingSshAccessOperation)
      const prepared =
        environment.pendingSshAccessOperation?.operation === 'link'
          ? cancelRuntimeEnvironmentSshAccessLink(userDataPath, {
              expectedEnvironment: environment,
              requestId: args.requestId
            })
          : prepareRuntimeEnvironmentSshAccessUnlink(userDataPath, {
              expectedEnvironment: environment,
              requestId: args.requestId
            })
      await options.invalidateTransport(environmentId)
      await closeOrcadManagedTunnel(environmentId)
      const target = requireFence(claims, environmentId, access, true)
      if (target.orcadFence && !claims.release(target.id, environmentId)) {
        throw new Error('The SSH target owner changed before access could be released.')
      }
      await claims.flush()
      requireFence(claims, environmentId, access, true)
      return redactRuntimeEnvironment(
        completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
          expectedEnvironment: prepared,
          requestId: args.requestId
        })
      )
    })
  })
}
