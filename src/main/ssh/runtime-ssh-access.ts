import { createHash } from 'node:crypto'
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
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { SshTarget } from '../../shared/ssh-types'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { requireManagedOrcadInfrastructure } from './orcad-managed-runtime-context'
import {
  closeOrcadManagedTunnel,
  ensureOrcadManagedTunnel,
  startOrcadManagedTunnel
} from './orcad-managed-tunnel'
import { verifyRuntimeEnvironmentSshTunnel } from './runtime-ssh-access-verification'
import { hasRegisteredDirectSshAuthority } from './ssh-target-registry'

type TargetStore = ReturnType<typeof requireManagedOrcadInfrastructure>['targetStore']

export function fingerprintRuntimeSshTarget(target: SshTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        host: target.host,
        port: target.port,
        username: target.username,
        configHost: target.configHost,
        identityFile: target.identityFile,
        identityAgent: target.identityAgent,
        identitiesOnly: target.identitiesOnly,
        gssapiAuthentication: target.gssapiAuthentication,
        proxyCommand: target.proxyCommand,
        jumpHost: target.jumpHost,
        systemSshConnectionReuse: target.systemSshConnectionReuse
      })
    )
    .digest('hex')
}

function requireTarget(store: TargetStore, targetId: string): SshTarget {
  const target = store.getTarget(targetId)
  if (!target || !Number.isSafeInteger(target.generation) || target.generation! <= 0) {
    throw new Error('SSH access requires an existing durable SSH target generation.')
  }
  if (target.orcadProvisioning) {
    throw new Error('This SSH target has pending server provisioning.')
  }
  if (
    store
      .getOrcadMigrationStore()
      .listOrcadMigrationSourceCutovers()
      .some((entry) => entry.manifest.source.sshTargetId === targetId)
  ) {
    throw new Error('This SSH target belongs to a migration cutover.')
  }
  return target
}

function requireAccessOnlyTarget(
  store: TargetStore,
  targetId: string,
  environmentId: string
): SshTarget {
  const target = requireTarget(store, targetId)
  if (hasRegisteredDirectSshAuthority(targetId)) {
    throw new Error('Disconnect direct SSH authority before linking access to this paired server.')
  }
  // Omitting the environment bypasses the same-owner shortcut and rechecks direct authority.
  const blockers = store
    .preflightOrcadRuntimeTarget(targetId)
    .blockers.filter(
      (entry) =>
        !(
          entry.code === 'orcad_migration_target_owned' &&
          getManagedOrcadOwnerEnvironmentId(target.owner) === environmentId
        )
    )
  if (blockers.length) {
    throw new Error(`SSH access cannot claim direct SSH authority: ${blockers[0].code}`)
  }
  return target
}

function requireFence(
  store: TargetStore,
  environmentId: string,
  fence: {
    sshTargetId: string
    sshTargetGeneration: number
    targetFingerprint?: string
  },
  allowUnowned = false
): SshTarget {
  const target = requireTarget(store, fence.sshTargetId)
  const owner = getManagedOrcadOwnerEnvironmentId(target.owner)
  if (
    target.generation !== fence.sshTargetGeneration ||
    !fence.targetFingerprint ||
    fingerprintRuntimeSshTarget(target) !== fence.targetFingerprint ||
    (owner !== environmentId && !(allowUnowned && !target.owner))
  ) {
    throw new Error('The SSH target registration, connection configuration, or owner changed.')
  }
  return target
}

async function flush(store: TargetStore): Promise<void> {
  await store.getOrcadMigrationStore().flushPendingOrThrowAsync({ drainToStableGeneration: false })
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
      const { targetStore, connectionManager } = requireManagedOrcadInfrastructure()
      const environment = resolveEnvironment(userDataPath, environmentId)
      assertRuntimeEnvironmentNotReconciling(environment)
      if (environment.orcadDeployment) {
        throw new Error('Managed deployments cannot use independent SSH access.')
      }
      const target = requireAccessOnlyTarget(targetStore, args.sshTargetId, environmentId)
      const fence = {
        sshTargetId: target.id,
        sshTargetGeneration: target.generation!,
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
        requireFence(targetStore, environmentId, access)
        await ensureOrcadManagedTunnel(userDataPath, environmentId)
        requireFence(targetStore, environmentId, access)
        await options.invalidateTransport?.(environmentId)
        return redactRuntimeEnvironment(resolveEnvironment(userDataPath, environmentId))
      }
      const prepared = prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
        expectedEnvironment: environment,
        requestId: args.requestId,
        remotePort: args.remotePort,
        ...fence
      })
      await flush(targetStore)
      requireAccessOnlyTarget(targetStore, target.id, environmentId)
      requireFence(targetStore, environmentId, fence, true)
      targetStore.claimOrcadRuntimeTarget(target.id, environmentId)
      await flush(targetStore)
      let tunnelStarted = false
      let linkCommitted = false
      try {
        options.signal?.throwIfAborted()
        const claimed = requireFence(targetStore, environmentId, fence)
        const connection = await connectionManager.connect(claimed)
        requireFence(targetStore, environmentId, fence)
        tunnelStarted = true
        const localPort = await startOrcadManagedTunnel(
          environmentId,
          claimed,
          connection,
          args.remotePort
        )
        const proof = await verifyRuntimeEnvironmentSshTunnel(prepared, localPort, options.signal)
        options.signal?.throwIfAborted()
        requireAccessOnlyTarget(targetStore, target.id, environmentId)
        requireFence(targetStore, environmentId, fence)
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
      const { targetStore } = requireManagedOrcadInfrastructure()
      requireFence(targetStore, environmentId, access, !!environment.pendingSshAccessOperation)
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
      const target = requireFence(targetStore, environmentId, access, true)
      if (target.owner && !targetStore.releaseOrcadRuntimeTarget(target.id, environmentId)) {
        throw new Error('The SSH target owner changed before access could be released.')
      }
      await flush(targetStore)
      requireFence(targetStore, environmentId, access, true)
      return redactRuntimeEnvironment(
        completeRuntimeEnvironmentSshAccessUnlink(userDataPath, {
          expectedEnvironment: prepared,
          requestId: args.requestId
        })
      )
    })
  })
}
