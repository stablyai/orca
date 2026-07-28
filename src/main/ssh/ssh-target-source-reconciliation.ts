import type { SshTarget } from '../../shared/ssh-types'

export type SshTargetManagedSource = { kind: 'ssh-config' } | { kind: 'custom'; sourceId: string }

export type SshTargetSourceChange =
  | {
      kind: 'update'
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }
  | {
      kind: 'insert'
      target: SshTarget
    }

type ReconcileSshTargetSourceOptions = {
  source: SshTargetManagedSource
  existingTargets: readonly SshTarget[]
  candidates: readonly SshTarget[]
  deletedTargetKeys: ReadonlySet<string>
  adoptLegacySshConfigTargets?: boolean
}

type SshTargetSourceOwnershipOptions = {
  adoptLegacySshConfigTargets?: boolean
}

const SYNCED_CONNECTION_FIELDS = [
  'configHost',
  'host',
  'port',
  'username',
  'identityFile',
  'identityAgent',
  'identitiesOnly',
  'gssapiAuthentication',
  'proxyCommand',
  'jumpHost'
] as const satisfies readonly (keyof SshTarget)[]

export function reconcileSshTargetsFromSource(
  options: ReconcileSshTargetSourceOptions
): SshTargetSourceChange[] {
  const managedTargets = new Map<string, SshTarget>()
  const reservedTargetKeys = new Set<string>()

  for (const target of options.existingTargets) {
    const key = getSshTargetSourceKey(target)
    if (
      !isSshTargetManagedBySource(target, options.source, {
        adoptLegacySshConfigTargets: options.adoptLegacySshConfigTargets
      })
    ) {
      reservedTargetKeys.add(key)
      continue
    }
    if (key && !managedTargets.has(key)) {
      managedTargets.set(key, target)
    }
  }

  const changes: SshTargetSourceChange[] = []
  const processedTargetKeys = new Set<string>()
  for (const candidate of options.candidates) {
    const key = getSshTargetSourceKey(candidate)
    if (
      reservedTargetKeys.has(key) ||
      options.deletedTargetKeys.has(key) ||
      processedTargetKeys.has(key)
    ) {
      continue
    }
    processedTargetKeys.add(key)

    const existing = managedTargets.get(key)
    if (!existing) {
      changes.push({ kind: 'insert', target: stampSshTargetSource(candidate, options.source) })
      continue
    }

    const updates = getSshTargetSourceUpdates(candidate, options.source)
    if (hasSshTargetSourceChanges(existing, updates)) {
      changes.push({ kind: 'update', id: existing.id, updates })
    }
  }
  return changes
}

export function isLegacySshConfigImportTarget(target: SshTarget): boolean {
  const alias = getSshTargetSourceKey(target)
  return Boolean(
    alias && target.label === alias && target.configHost === alias && target.host !== alias
  )
}

export function getSshTargetSourceKey(target: SshTarget): string {
  return target.configHost ?? target.label
}

export function isSshTargetManagedBySource(
  target: SshTarget,
  source: SshTargetManagedSource,
  options: SshTargetSourceOwnershipOptions = {}
): boolean {
  if (source.kind === 'custom') {
    return target.source === 'custom' && target.sourceId === source.sourceId
  }
  return (
    target.source === 'ssh-config' ||
    (options.adoptLegacySshConfigTargets === true &&
      target.source === undefined &&
      isLegacySshConfigImportTarget(target))
  )
}

function getSshTargetSourceUpdates(
  candidate: SshTarget,
  source: SshTargetManagedSource
): Partial<Omit<SshTarget, 'id'>> {
  const updates: Partial<Omit<SshTarget, 'id'>> = {}
  for (const field of SYNCED_CONNECTION_FIELDS) {
    Object.assign(updates, { [field]: candidate[field] })
  }
  return source.kind === 'custom'
    ? { ...updates, source: 'custom', sourceId: source.sourceId }
    : { ...updates, source: 'ssh-config' }
}

function stampSshTargetSource(candidate: SshTarget, source: SshTargetManagedSource): SshTarget {
  if (source.kind === 'custom') {
    return { ...candidate, source: 'custom', sourceId: source.sourceId }
  }
  const { sourceId: _sourceId, ...target } = candidate
  return { ...target, source: 'ssh-config' }
}

function hasSshTargetSourceChanges(
  existing: SshTarget,
  updates: Partial<Omit<SshTarget, 'id'>>
): boolean {
  return (Object.keys(updates) as (keyof typeof updates)[]).some(
    (key) => existing[key] !== updates[key]
  )
}
