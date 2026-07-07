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
  sanitizeServiceCommandOutput
} from './worktree-service-command'

export {
  SERVICE_COMMAND_TIMEOUT_MS,
  sanitizeServiceCommandOutput
} from './worktree-service-command'

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

  // Why: a retry of a create_failed worktree must reuse its slot/slug so ports stay stable.
  const existing = getWorktreeServicesRecord(userDataPath, worktreeId)
  const reuse = existing?.status === 'create_failed' ? existing : null
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

  const commandEnv = { ...contextEnv, ORCA_WORKTREE_PATH: worktreePath }
  const resolvedEnv: Record<string, string> = { ...contextEnv }
  const created: OrcaServiceRecipe[] = []

  for (const service of services) {
    const result = await runServiceCommand(
      service.create,
      worktreePath,
      commandEnv,
      (stream, chunk) =>
        args.onEvent?.({
          provisionId,
          serviceId: service.id,
          stream,
          chunk: sanitizeServiceCommandOutput(chunk)
        })
    )
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

  // Why: freeing the slot must not depend on destroy success — a failed destroy
  // otherwise leaks the slot forever. Removal is non-blocking per spec.
  removeWorktreeServicesRecord(userDataPath, worktreeId)
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
  const states: WorktreeServiceRuntimeState[] = []
  for (const service of args.services) {
    if (!provisioned.has(service.id)) {
      continue
    }
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
    states.push({
      serviceId: service.id,
      name: service.name,
      runState,
      canStart: Boolean(service.start),
      canStop: Boolean(service.stop)
    })
  }
  return states
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
