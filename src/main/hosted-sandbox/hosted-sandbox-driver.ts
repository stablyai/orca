// Orca Cloud workspaces: an EnvironmentProviderDriver that talks only to Orca's control plane.
// Which provider runs the VM (Vercel today) is a control-plane detail the desktop never sees.
import {
  HOSTED_SANDBOX_MACHINE_SIZES,
  ORCA_CLOUD_IDLE_SLEEP_MINUTES,
  type HostedSandboxMachineSize,
  type HostedSandboxReadyResponse,
  type HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  EnvironmentProviderError,
  isEnvironmentProviderError,
  type EnvironmentHandle,
  type EnvironmentStatus
} from '../environment-providers/environment-provider-driver'
import { environmentRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import type {
  HostedEnvironmentCapabilities,
  HostedEnvironmentProviderDriver,
  HostedEnvironmentReady,
  HostedSessionInfo,
  HostedStatusSnapshot
} from './hosted-environment-provider'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

export const HOSTED_SANDBOX_DRIVER_ID = 'orca-cloud'

/** Measured on Vercel: stop is a reboot (PTYs lost), disk persists, Pro caps a session at 24h. */
export const HOSTED_SANDBOX_CAPABILITIES: HostedEnvironmentCapabilities = Object.freeze({
  memoryPause: false,
  maxSessionMs: 24 * 60 * 60_000,
  fsPersistOnStop: true,
  egressInjection: true,
  idleStopMs: ORCA_CLOUD_IDLE_SLEEP_MINUTES * 60_000
})

const STATUS: Record<HostedSandboxView['status'], EnvironmentStatus> = {
  creating: 'provisioning',
  running: 'running',
  suspending: 'suspending',
  suspended: 'suspended',
  resuming: 'resuming',
  destroying: 'destroying',
  destroyed: 'destroyed',
  failed: 'failed',
  // Archived = asleep with a snapshot TTL; the desktop shows it as a sleeping environment.
  archived: 'suspended'
}

export function createHostedSandboxDriver(
  client: HostedSandboxControlPlaneClient
): HostedEnvironmentProviderDriver {
  return {
    id: HOSTED_SANDBOX_DRIVER_ID,
    capabilities: HOSTED_SANDBOX_CAPABILITIES,

    async create(spec, ctx) {
      const machineSize = toMachineSize(spec.machineSize)
      ctx?.onProgress?.({ phase: 'provisioning' })
      const ready = await client.create(
        {
          workspaceId: spec.workspaceId,
          machineSize,
          ...(spec.region ? { region: spec.region } : {}),
          ...(spec.repo ? { repo: spec.repo } : {})
        },
        ctx?.signal
      )
      ctx?.onProgress?.({ phase: 'connecting' })
      return toReady(ready)
    },

    async resume(handle, ctx) {
      ctx?.onProgress?.({ phase: 'resuming' })
      const ready = await client.resume(sandboxIdOf(handle), ctx?.signal)
      ctx?.onProgress?.({ phase: 'connecting' })
      return toReady(ready)
    },

    async suspend(handle, ctx) {
      ctx?.onProgress?.({ phase: 'suspending' })
      return toSnapshot(await client.suspend(sandboxIdOf(handle), ctx?.signal))
    },

    async destroy(handle, ctx) {
      ctx?.onProgress?.({ phase: 'destroying' })
      try {
        await client.destroy(sandboxIdOf(handle), ctx?.signal)
      } catch (error) {
        // Why: destroy is the cleanup of last resort, so an environment that is already gone is done.
        if (!isEnvironmentProviderError(error, 'not_found')) {
          throw error
        }
      }
    },

    async status(handle, ctx) {
      return toSnapshot(await client.get(sandboxIdOf(handle), ctx?.signal))
    },

    async renewLease(handle, extendMs, ctx) {
      return toSnapshot(await client.renewLease(sandboxIdOf(handle), extendMs, ctx?.signal))
    },

    async rollover(handle, ctx) {
      ctx?.onProgress?.({ phase: 'resuming' })
      const ready = await client.rollover(sandboxIdOf(handle), ctx?.signal)
      ctx?.onProgress?.({ phase: 'connecting' })
      return toReady(ready)
    }
  }
}

function toMachineSize(value: string | undefined): HostedSandboxMachineSize {
  if (value === undefined) {
    return 'standard'
  }
  const size = HOSTED_SANDBOX_MACHINE_SIZES.find((candidate) => candidate === value)
  if (!size) {
    throw new EnvironmentProviderError('invalid_request', `Unknown machine size: ${value}`)
  }
  return size
}

function sandboxIdOf(handle: EnvironmentHandle): string {
  const id = handle.driverState.sandboxId
  if (handle.driverId !== HOSTED_SANDBOX_DRIVER_ID || typeof id !== 'string' || !id) {
    throw new EnvironmentProviderError('invalid_request', 'Not an Orca Cloud environment handle.')
  }
  return id
}

function toSession(view: HostedSandboxView): HostedSessionInfo | null {
  return view.session
    ? {
        startedAt: view.session.startedAt,
        deadlineAt: view.session.deadlineAt,
        leaseExpiresAt: view.session.leaseExpiresAt
      }
    : null
}

function toSnapshot(view: HostedSandboxView): HostedStatusSnapshot {
  return { status: STATUS[view.status], session: toSession(view) }
}

export function toReady(ready: HostedSandboxReadyResponse): HostedEnvironmentReady {
  const session = toSession(ready.sandbox)
  if (ready.sandbox.status !== 'running' || !session) {
    throw new EnvironmentProviderError(
      'invalid_response',
      'Orca Cloud reported a connection for an environment that is not running.'
    )
  }
  const handle: EnvironmentHandle = {
    driverId: HOSTED_SANDBOX_DRIVER_ID,
    environmentId: ready.sandbox.id,
    driverState: { sandboxId: ready.sandbox.id }
  }
  return {
    handle,
    result: environmentRecipeResult(handle, ready.connection, 'orca-worktree'),
    session
  }
}
