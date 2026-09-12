import type {
  OrcadSshPendingProvisioning,
  OrcadSshProvisioningRequest,
  OrcadSshProvisioningResult
} from '../../shared/orcad-ssh-provisioning'
import type { SshRepoReadoption, SshTarget, SshTargetCreateInput } from '../../shared/ssh-types'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'
import { requireManagedOrcadTargetStore } from './orcad-managed-runtime-context'
import { createManagedOrcadEnvironment } from './orcad-runtime-deployment'
import { normalizeSshTarget } from '../persistence/leasing-ssh-ptys/ssh-normalization'
import { rotateSshProviderAuthority } from './ssh-provider-authority'
import { EphemeralVmRecipeSshTargetSchema } from '../../shared/ephemeral-vm-recipes'
import { z } from 'zod'
import { normalizeSshConfigAlias } from '../../shared/ssh-config-alias'

const provisioningTargetSchema = EphemeralVmRecipeSshTargetSchema.extend({
  gssapiAuthentication: z.boolean().optional(),
  systemSshConnectionReuse: z.boolean().optional(),
  source: z.enum(['manual', 'ssh-config']).optional(),
  lastRequiredPassphrase: z.boolean().optional()
})

export function listPendingOrcadSshProvisioning(): OrcadSshPendingProvisioning[] {
  const store = requireManagedOrcadTargetStore().getOrcadMigrationStore()
  const completed = new Set(
    store
      .listOrcadMigrationSourceCutovers()
      .filter((cutover) => cutover.phase === 'source-retired')
      .map((cutover) => cutover.manifest.source.sshTargetId)
  )
  return store
    .getSshTargets()
    .flatMap((target) =>
      target.orcadProvisioning && !completed.has(target.id)
        ? [{ ...target.orcadProvisioning, sshTargetId: target.id }]
        : []
    )
}

export function createOrcadSshHost(
  userDataPath: string,
  request: OrcadSshProvisioningRequest
): Promise<OrcadSshProvisioningResult> {
  const requestId = requireRequestId(request?.requestId)
  const name = requireText(request?.name, 'Server name')
  const targetInput = parseTarget(request?.target)
  return runTargetLifecycle(`orcad-provision:${userDataPath}:${requestId}`, async () => {
    const targetStore = requireManagedOrcadTargetStore()
    const targets = targetStore.getOrcadMigrationStore().getSshTargets()
    let target = targets.find((entry) => entry.orcadProvisioning?.requestId === requestId)
    let repoReadoptions: SshRepoReadoption[] = []
    if (target) {
      if (target.orcadProvisioning?.name !== name || !matchesRequest(target, targetInput)) {
        throw new Error('This provisioning request already belongs to another host or server name.')
      }
    } else {
      if (targets.some((entry) => sameEndpoint(entry, targetInput))) {
        throw new Error(
          'That SSH host is already registered. Use its existing server or migration flow.'
        )
      }
      target = targetStore.addTarget({
        ...targetInput,
        source: 'manual',
        orcadProvisioning: { requestId, name }
      })
      repoReadoptions = [...targetStore.lastRepoReadoptions]
      targetStore.lastRepoReadoptions = []
      for (const targetId of new Set(
        repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
      )) {
        rotateSshProviderAuthority(targetId)
      }
    }
    return provision(userDataPath, target, repoReadoptions)
  })
}

export function resumeOrcadSshHost(
  userDataPath: string,
  requestIdInput: string
): Promise<OrcadSshProvisioningResult> {
  const requestId = requireRequestId(requestIdInput)
  return runTargetLifecycle(`orcad-provision:${userDataPath}:${requestId}`, async () => {
    const target = requireManagedOrcadTargetStore()
      .getOrcadMigrationStore()
      .getSshTargets()
      .find((entry) => entry.orcadProvisioning?.requestId === requestId)
    if (!target) {
      throw new Error('The managed SSH provisioning request was not found.')
    }
    return provision(userDataPath, target, [])
  })
}

async function provision(
  userDataPath: string,
  target: SshTarget,
  repoReadoptions: SshRepoReadoption[]
): Promise<OrcadSshProvisioningResult> {
  const intent = target.orcadProvisioning!
  // Publish the intent and any re-adopted catalog before contacting the execution host.
  await requireManagedOrcadTargetStore().getOrcadMigrationStore().flushPendingOrThrowAsync({
    drainToStableGeneration: false
  })
  const base = { ...intent, sshTargetId: target.id, repoReadoptions }
  try {
    return {
      ...base,
      result: await createManagedOrcadEnvironment(userDataPath, {
        name: intent.name,
        sshTargetId: target.id
      })
    }
  } catch (error) {
    return {
      ...base,
      result: {
        outcome: 'pending',
        reason: error instanceof Error ? error.message : 'Managed SSH provisioning failed.'
      }
    }
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new Error(`${label} is required and must not exceed 1024 characters.`)
  }
  return value.trim()
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('A stable managed SSH provisioning request id is required.')
  }
  return value
}

function parseTarget(value: SshTargetCreateInput): SshTargetCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.owner !== undefined) {
    throw new Error('A new unowned SSH host is required.')
  }
  const {
    id: _id,
    generation: _generation,
    orcadProvisioning: _intent,
    ...raw
  } = value as SshTarget
  const target = provisioningTargetSchema.parse(raw)
  return {
    ...target,
    label: requireText(target.label, 'SSH host label'),
    host: requireText(target.host, 'SSH host'),
    username: target.username.trim(),
    configHost: target.configHost?.trim() || target.host.trim()
  }
}

function sameEndpoint(left: SshTarget, right: SshTargetCreateInput): boolean {
  const alias = normalizeSshConfigAlias(right.configHost ?? right.host)
  if (
    alias &&
    [left.configHost, left.label].some((value) => normalizeSshConfigAlias(value) === alias)
  ) {
    return true
  }
  return left.host === right.host && left.port === right.port && left.username === right.username
}

function matchesRequest(target: SshTarget, input: SshTargetCreateInput): boolean {
  return Object.entries(normalizeSshTarget({ ...input, id: target.id })).every(
    ([key, value]) =>
      key === 'source' || JSON.stringify(target[key as keyof SshTarget]) === JSON.stringify(value)
  )
}
