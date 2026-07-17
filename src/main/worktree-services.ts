import { loadHooks } from './hooks'
import {
  buildServiceContextEnv,
  deriveServiceSlug,
  resolveServiceEnv
} from '../shared/worktree-service-env'
import {
  allocateServiceSlot,
  getWorktreeServicesRecord,
  removeWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from '../shared/worktree-services-store'
import type { OrcaServiceRecipe, Repo } from '../shared/types'
import type {
  WorktreeServiceRuntimeState,
  WorktreeServicesRecord
} from '../shared/worktree-services'
import {
  SERVICE_STATUS_TIMEOUT_MS,
  runServiceCommand,
  sanitizeServiceCommandOutput,
  type ServiceCommandResult
} from './worktree-service-command'

export {
  SERVICE_COMMAND_TIMEOUT_MS,
  sanitizeServiceCommandOutput
} from './worktree-service-command'

// Why: provisioning reads recipes from the worktree's own orca.yaml (the
// checked-out branch may declare services the repo's default checkout does
// not), so every later lifecycle command (status/start/stop/destroy/retry)
// must resolve from the same source, falling back to the repo root only when
// the worktree copy is missing or declares none.
export function loadServiceRecipesForWorktree(
  worktreePath: string,
  repoPath: string
): OrcaServiceRecipe[] {
  const worktreeServices = loadHooks(worktreePath)?.services
  if (worktreeServices && worktreeServices.length > 0) {
    return worktreeServices
  }
  return loadHooks(repoPath)?.services ?? []
}

export type ServiceProvisionEvent = {
  provisionId: string
  serviceId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export type ProvisionWorktreeServicesArgs = {
  userDataPath: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
  repo: Repo
  services: OrcaServiceRecipe[]
  provisionId?: string
  onEvent?: (event: ServiceProvisionEvent) => void
}

export async function provisionWorktreeServices(
  args: ProvisionWorktreeServicesArgs
): Promise<WorktreeServicesRecord> {
  const { userDataPath, worktreeId, worktreeName, worktreePath, repo, services } = args
  const provisionId = args.provisionId ?? worktreeId

  // Why: reuse any existing record's slot/slug/createdAt on re-provision (retry
  // of a create_failed worktree, or a repeat provision of a ready one) so ports
  // stay stable and the prior slug's containers are never orphaned by a fresh slot.
  const existing = getWorktreeServicesRecord(userDataPath, worktreeId)
  const reuse = existing
  const slot = reuse ? reuse.slot : allocateServiceSlot(userDataPath)
  const slug = reuse ? reuse.slug : deriveServiceSlug(worktreeName, slot)
  const contextEnv = buildServiceContextEnv(slug, slot)
  const now = new Date().toISOString()
  const createdAt = reuse ? reuse.createdAt : now

  upsertWorktreeServicesRecord(userDataPath, {
    worktreeId,
    repoId: repo.id,
    slot,
    slug,
    serviceIds: services.map((service) => service.id),
    env: contextEnv,
    status: 'provisioning',
    createdAt,
    updatedAt: now
  })

  if (services.length === 0) {
    return upsertWorktreeServicesRecord(userDataPath, {
      worktreeId,
      repoId: repo.id,
      slot,
      slug,
      serviceIds: [],
      env: contextEnv,
      status: 'create_failed',
      error: 'The worktree has no valid isolated service recipes.',
      createdAt,
      updatedAt: new Date().toISOString()
    })
  }

  const commandEnv = { ...contextEnv, ORCA_WORKTREE_PATH: worktreePath }
  const resolvedEnv: Record<string, string> = { ...contextEnv }
  const created: OrcaServiceRecipe[] = []

  for (const service of services) {
    let result: ServiceCommandResult
    try {
      result = await runServiceCommand(service.create, worktreePath, commandEnv, (stream, chunk) =>
        args.onEvent?.({
          provisionId,
          serviceId: service.id,
          stream,
          chunk: sanitizeServiceCommandOutput(chunk)
        })
      )
    } catch (error) {
      // Why: a synchronous child-process failure must become retryable state;
      // leaving `provisioning` persisted would hide the retry until app restart.
      result = {
        success: false,
        output: error instanceof Error ? error.message : String(error)
      }
    }
    if (!result.success) {
      await destroyCreatedServices(created.toReversed(), worktreePath, contextEnv)
      return upsertWorktreeServicesRecord(userDataPath, {
        worktreeId,
        repoId: repo.id,
        slot,
        slug,
        serviceIds: services.map((s) => s.id),
        env: contextEnv,
        status: 'create_failed',
        error:
          `Service "${service.id}" create failed: ${sanitizeServiceCommandOutput(result.output)}`.trim(),
        createdAt,
        updatedAt: new Date().toISOString()
      })
    }
    Object.assign(resolvedEnv, resolveServiceEnv(service.env, contextEnv))
    // Why: parser validation protects normal yaml input, but lifecycle code can
    // also receive programmatic/legacy recipes. The allocated context remains
    // authoritative so later destroy commands target the same slot as create.
    Object.assign(resolvedEnv, contextEnv)
    created.push(service)
  }

  return upsertWorktreeServicesRecord(userDataPath, {
    worktreeId,
    repoId: repo.id,
    slot,
    slug,
    serviceIds: services.map((service) => service.id),
    env: resolvedEnv,
    status: 'ready',
    createdAt,
    updatedAt: new Date().toISOString()
  })
}

async function destroyCreatedServices(
  services: OrcaServiceRecipe[],
  worktreePath: string,
  contextEnv: Record<string, string>
): Promise<void> {
  const env = { ...contextEnv, ORCA_WORKTREE_PATH: worktreePath }
  for (const service of services) {
    if (service.destroy) {
      await runServiceCommand(service.destroy, worktreePath, env)
    }
  }
}

export async function destroyWorktreeServices(args: {
  userDataPath: string
  worktreeId: string
  worktreePath: string
  repo: Repo
  services: OrcaServiceRecipe[]
  releaseRecord?: boolean
}): Promise<{ success: boolean; errors: string[] }> {
  const { userDataPath, worktreeId, worktreePath, services } = args
  const record = getWorktreeServicesRecord(userDataPath, worktreeId)
  if (!record) {
    return { success: true, errors: [] }
  }

  const errors: string[] = []
  const env = { ...record.env, ORCA_WORKTREE_PATH: worktreePath }
  const provisioned = new Set(record.serviceIds)
  for (const service of services) {
    if (!provisioned.has(service.id) || !service.destroy) {
      continue
    }
    const result = await runServiceCommand(service.destroy, worktreePath, env)
    if (!result.success) {
      errors.push(
        `Service "${service.id}" destroy failed: ${sanitizeServiceCommandOutput(result.output)}`.trim()
      )
    }
  }

  // Why: recipes are re-resolved from the current yaml at destroy time. If a
  // provisioned service's id is no longer declared (a branch or agent edit of
  // orca.yaml between provision and removal), its containers can't be torn down;
  // surface that instead of silently reporting success while it keeps running.
  const currentServiceIds = new Set(services.map((service) => service.id))
  for (const serviceId of record.serviceIds) {
    if (!currentServiceIds.has(serviceId)) {
      errors.push(
        `Service "${serviceId}" recipe is no longer declared in orca.yaml; it may still be running.`
      )
    }
  }

  // Why: ordinary/orphan cleanup frees the slot even when a destroy command
  // fails, but worktree deletion retains it until Git removal commits so a
  // failed delete cannot race a new worktree onto the same deterministic ports.
  if (args.releaseRecord !== false) {
    removeWorktreeServicesRecord(userDataPath, worktreeId)
  }
  return { success: errors.length === 0, errors }
}

export async function getWorktreeServicesRuntime(args: {
  userDataPath: string
  worktreeId: string
  worktreePath: string
  services: OrcaServiceRecipe[]
}): Promise<WorktreeServiceRuntimeState[]> {
  const record = getWorktreeServicesRecord(args.userDataPath, args.worktreeId)
  if (!record) {
    return []
  }
  const env = { ...record.env, ORCA_WORKTREE_PATH: args.worktreePath }
  const provisioned = new Set(record.serviceIds)
  const services = args.services.filter((service) => provisioned.has(service.id))
  // Why: status probes are read-only and independent. Serial awaits make panel
  // latency N×30s when several services are unhealthy; parallel probes cap it
  // at the slowest service while preserving recipe order in the returned array.
  return Promise.all(
    services.map(async (service): Promise<WorktreeServiceRuntimeState> => {
      let runState: WorktreeServiceRuntimeState['runState'] = 'unknown'
      if (service.status) {
        const result = await runServiceCommand(
          service.status,
          args.worktreePath,
          env,
          undefined,
          SERVICE_STATUS_TIMEOUT_MS
        )
        runState = result.success ? 'running' : 'stopped'
      }
      return {
        serviceId: service.id,
        name: service.name,
        runState,
        canStart: Boolean(service.start),
        canStop: Boolean(service.stop)
      }
    })
  )
}

export async function runWorktreeServiceAction(args: {
  userDataPath: string
  worktreeId: string
  worktreePath: string
  services: OrcaServiceRecipe[]
  action: 'start' | 'stop'
  serviceId?: string // omitted = every provisioned service that declares the command
}): Promise<{ success: boolean; errors: string[] }> {
  const record = getWorktreeServicesRecord(args.userDataPath, args.worktreeId)
  if (!record) {
    return { success: false, errors: ['No provisioned services for this worktree.'] }
  }
  const env = { ...record.env, ORCA_WORKTREE_PATH: args.worktreePath }
  const provisioned = new Set(record.serviceIds)
  const errors: string[] = []
  // Why: a stale panel can target a service that is no longer provisioned or
  // declared; silently succeeding would hide that the action never ran.
  if (
    args.serviceId &&
    !args.services.some((s) => s.id === args.serviceId && provisioned.has(s.id))
  ) {
    return {
      success: false,
      errors: [`Service "${args.serviceId}" is not provisioned for this worktree.`]
    }
  }
  for (const service of args.services) {
    if (!provisioned.has(service.id)) {
      continue
    }
    if (args.serviceId && service.id !== args.serviceId) {
      continue
    }
    const command = service[args.action]
    if (!command) {
      if (args.serviceId) {
        errors.push(`Service "${service.id}" has no ${args.action} command.`)
      }
      continue
    }
    const result = await runServiceCommand(command, args.worktreePath, env)
    if (!result.success) {
      errors.push(
        `Service "${service.id}" ${args.action} failed: ${sanitizeServiceCommandOutput(result.output)}`.trim()
      )
    }
  }
  return { success: errors.length === 0, errors }
}
