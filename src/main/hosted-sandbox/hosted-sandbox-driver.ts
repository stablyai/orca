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
  type EnvironmentProviderCallContext,
  type EnvironmentCreateSpec,
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
import { takeSuspendReason } from './idle-sleep-requests'
import { reclaimCancelledCreate } from './hosted-sandbox-create-reclaim'

export const HOSTED_SANDBOX_DRIVER_ID = 'orca-cloud'

/** Destroy failure reason: the control plane didn't confirm the sandbox is gone. */
export const HOSTED_SANDBOX_DELETE_NOT_CONFIRMED = 'delete_not_confirmed'

/** Measured on Vercel: stop is a reboot (PTYs lost), disk persists, Pro caps a session at 24h. */
export const HOSTED_SANDBOX_CAPABILITIES: HostedEnvironmentCapabilities = Object.freeze({
  memoryPause: false,
  maxSessionMs: 24 * 60 * 60_000,
  fsPersistOnStop: true,
  egressInjection: true,
  // Fallback only: the control plane's status (`idleSleepMinutes`) wins once read.
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
      return toReady(await createSandboxWithProgress(client, spec, ctx))
    },

    async resume(handle, ctx) {
      ctx?.onProgress?.({ phase: 'resuming' })
      const ready = await client.resume(sandboxIdOf(handle), ctx?.signal)
      ctx?.onProgress?.({ phase: 'connecting' })
      return toReady(ready)
    },

    async suspend(handle, ctx) {
      ctx?.onProgress?.({ phase: 'suspending' })
      const sandboxId = sandboxIdOf(handle)
      return toSnapshot(await client.suspend(sandboxId, ctx?.signal, takeSuspendReason(sandboxId)))
    },

    async destroy(handle, ctx) {
      ctx?.onProgress?.({ phase: 'destroying' })
      let view: { status: HostedSandboxView['status'] }
      try {
        view = await client.destroy(sandboxIdOf(handle), ctx?.signal)
      } catch (error) {
        // Why: the control plane keeps a tombstone for every sandbox it ever made, so a repeat
        // delete answers "destroyed". not_found means this identity can't see it (another account,
        // team or a signed-out token): the sandbox may still be running and billing. Never call
        // that deleted.
        if (isEnvironmentProviderError(error, 'not_found')) {
          throw new EnvironmentProviderError(
            'not_found',
            "Orca Cloud couldn't confirm this sandbox was deleted.",
            HOSTED_SANDBOX_DELETE_NOT_CONFIRMED
          )
        }
        throw error
      }
      if (view.status !== 'destroyed') {
        throw new EnvironmentProviderError(
          'unavailable',
          `Orca Cloud answered ${view.status} instead of destroyed.`
        )
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

/**
 * One create with the build sheet's progress: the boot plan names the repository step, then the
 * create, then git's clone or update until it is done. Shared by the owned create (the recipe) and
 * the GitHub-only create (GH-CREATE-SHEET), so both sheets read the same phases.
 */
export async function createSandboxWithProgress(
  client: Pick<HostedSandboxControlPlaneClient, 'create' | 'bootPlan' | 'cloneStatus' | 'destroy'>,
  spec: EnvironmentCreateSpec,
  ctx?: EnvironmentProviderCallContext
): Promise<HostedSandboxReadyResponse> {
  const machineSize = toMachineSize(spec.machineSize)
  ctx?.onProgress?.({ phase: 'provisioning' })
  // Names the repository step before the create answers (no relabel mid-run). Best effort: an
  // older control plane answers 404 and the step is named when the create answers.
  if (spec.repo) {
    void client
      .bootPlan(spec.repo.url, ctx?.signal)
      .then((plan) =>
        ctx?.onProgress?.({ phase: plan === 'update' ? 'plan-update' : 'plan-clone' })
      )
      .catch(() => undefined)
  }
  const body = {
    workspaceId: spec.workspaceId,
    machineSize,
    // Named rows: Home shows the workspace's name, never an untitled sandbox (PC-8).
    ...(spec.workspaceName?.trim() ? { title: spec.workspaceName.trim().slice(0, 120) } : {}),
    ...(spec.region ? { region: spec.region } : {}),
    ...(spec.repo ? { repo: spec.repo } : {})
  }
  let ready: HostedSandboxReadyResponse
  try {
    ready = await client.create(body, ctx?.signal, spec.idempotencyKey)
  } catch (error) {
    // GH-CREATE-CANCEL: cancelled in flight, the control plane may still have made it: find it by
    // its key and delete it before reporting the cancel.
    if (ctx?.signal?.aborted && spec.idempotencyKey) {
      await reclaimCancelledCreate(client, body, spec.idempotencyKey)
    }
    throw error
  }
  if (ready.clone) {
    // A cancelled, failed or stalled clone deletes the sandbox itself.
    await waitForClone(client, ready.sandbox.id, ctx, { mode: ready.clone.mode ?? 'clone' })
  }
  if (ctx?.signal?.aborted) {
    // Cancelled just as it answered: nothing will use it, so it must not keep running (and billing).
    await client.destroy(ready.sandbox.id).catch(() => undefined)
    throw new EnvironmentProviderError('aborted', 'Cancelled.')
  }
  ctx?.onProgress?.({ phase: 'connecting' })
  return ready
}

/** A clone whose progress has not moved this long is stuck (git's own silent stretches are ~20 s). */
export const CLONE_STALL_MS = 5 * 60_000
const CLONE_POLL_MS = 1_000

function cloneFailure(reason: string): EnvironmentProviderError {
  return new EnvironmentProviderError(
    'conflict',
    `Orca Cloud couldn't clone the repository (${reason}).`,
    `clone:${reason}`
  )
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EnvironmentProviderError('aborted', 'Cancelled.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new EnvironmentProviderError('aborted', 'Cancelled.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The sandbox is up and the repo clones in it: report git's progress until it is done. A failed,
 * stalled or cancelled clone deletes the sandbox (the caller never got its handle, so nothing else
 * would) and fails the create with the clone's reason.
 */
export async function waitForClone(
  client: Pick<HostedSandboxControlPlaneClient, 'cloneStatus' | 'destroy'>,
  sandboxId: string,
  ctx?: EnvironmentProviderCallContext,
  {
    now = Date.now,
    pollMs = CLONE_POLL_MS,
    mode = 'clone'
  }: { now?: () => number; pollMs?: number; mode?: 'clone' | 'update' } = {}
): Promise<void> {
  const phase = mode === 'update' ? 'updating' : 'cloning'
  ctx?.onProgress?.({ phase })
  let lastProgress = ''
  let movedAt = now()
  try {
    for (;;) {
      await delay(pollMs, ctx?.signal)
      let status: Awaited<ReturnType<HostedSandboxControlPlaneClient['cloneStatus']>> | null = null
      try {
        status = await client.cloneStatus(sandboxId, ctx?.signal)
      } catch (error) {
        // One failed poll is not a failed clone; a cancel or a dead sandbox ends it below.
        if (ctx?.signal?.aborted || isEnvironmentProviderError(error, 'not_found')) {
          throw error
        }
      }
      if (status?.state === 'done' || status?.state === 'none') {
        return
      }
      if (status?.state === 'failed') {
        throw cloneFailure(status.reason)
      }
      if (status?.state === 'running') {
        const progress = `${status.percent}:${status.stage}`
        if (progress !== lastProgress) {
          lastProgress = progress
          movedAt = now()
          ctx?.onProgress?.({ phase, percent: status.percent, message: status.stage })
        }
      }
      if (now() - movedAt > CLONE_STALL_MS) {
        throw cloneFailure('clone_stalled')
      }
    }
  } catch (error) {
    // Its own signal may be the reason we stopped: the delete must still go out.
    await client.destroy(sandboxId).catch(() => undefined)
    throw error
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
    driverState: {
      sandboxId: ready.sandbox.id,
      // Booted from an org environment build: dependencies are installed, so no setup-script nudge.
      ...(ready.sandbox.environmentBuildId
        ? { environmentBuildId: ready.sandbox.environmentBuildId }
        : {})
    }
  }
  return {
    handle,
    result: environmentRecipeResult(handle, ready.connection, 'orca-worktree'),
    session
  }
}
