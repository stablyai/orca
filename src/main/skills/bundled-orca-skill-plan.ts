import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import type {
  BundledSkillLeaveReason,
  BundledSkillLocationPlan,
  BundledSkillPlan
} from '../../shared/skill-freshness'
import {
  bundledInstallContext,
  prepareBundledSkill,
  requireBundledPackages,
  type BundledOrcaSkillInstallInput,
  type PreparedBundledSkill
} from './bundled-orca-skill-install'
import { BUNDLED_ORCA_SKILL_PACKAGES } from './bundled-orca-skill-packages'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { inspectSkillCanonicalState, type SkillCanonicalState } from './skill-install-planner'
import { skillInstallReplacementAllowed } from './skill-install-transaction-result'
import { resolveSkillProviderDestinations } from './skill-provider-destinations'
import { decideSkillProviderPlacement } from './skill-placement-decision'

const PLACEMENT_SKIP_REASONS: Readonly<Record<string, BundledSkillLeaveReason>> = {
  'skill-placement-modified-copy': 'local-changes',
  'skill-placement-unowned': 'not-installed-by-orca',
  'skill-placement-unowned-link': 'link-not-managed'
}

function canonicalLeaveReason(state: SkillCanonicalState): BundledSkillLeaveReason {
  switch (state.kind) {
    case 'external-link':
      return 'link-not-managed'
    case 'name-collision':
      return 'name-in-use'
    case 'modified':
    case 'unowned':
      // Why: a copy Orca cannot hash is not one it can call edited or foreign.
      if (state.digest === undefined) {
        return 'unreadable'
      }
      return state.kind === 'modified' ? 'local-changes' : 'not-installed-by-orca'
    // Why: replaceable states only land here when the caller cancels conflicts.
    case 'missing':
    case 'unchanged':
    case 'clean-update':
      return 'unreadable'
  }
}

// Why: a write the transaction would attempt into a read-only folder fails half-way, so the
// plan says so up front. Only the native filesystem can answer; WSL writes report on failure.
async function writable(path: string, prepared: PreparedBundledSkill): Promise<boolean> {
  if (prepared.request.filesystem) {
    return true
  }
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const result = await access(directory, constants.W_OK).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : false)
    )
    if (result !== null || dirname(directory) === directory) {
      return result ?? false
    }
  }
}

async function leaveIfReadOnly(
  location: BundledSkillLocationPlan,
  prepared: PreparedBundledSkill
): Promise<BundledSkillLocationPlan> {
  if (location.action === 'keep' || location.action === 'leave') {
    return location
  }
  return (await writable(location.path, prepared))
    ? location
    : { ...location, action: 'leave', reason: 'read-only' }
}

async function planSharedCopy(prepared: PreparedBundledSkill): Promise<BundledSkillLocationPlan> {
  const state = await inspectSkillCanonicalState({
    canonicalPath: prepared.canonicalPath,
    manifest: prepared.manifest,
    receipt: prepared.receipt,
    filesystem: prepared.request.filesystem
  })
  const base = {
    path: prepared.canonicalPath,
    role: 'shared' as const,
    exists: state.kind !== 'missing'
  }
  if (state.kind === 'unchanged') {
    return { ...base, action: 'keep' }
  }
  const replaceable =
    skillInstallReplacementAllowed(state, prepared.local) &&
    // Same refusal the transaction makes before it would move an unreadable copy aside.
    (state.kind === 'missing' || ('digest' in state && state.digest !== undefined))
  if (!replaceable) {
    return { ...base, action: 'leave', reason: canonicalLeaveReason(state) }
  }
  return leaveIfReadOnly(
    { ...base, action: state.kind === 'missing' ? 'install' : 'update' },
    prepared
  )
}

async function planAgentCopy(
  prepared: PreparedBundledSkill,
  rootPath: string,
  provider: string
): Promise<BundledSkillLocationPlan> {
  const path = join(rootPath, prepared.entry.name)
  const decision = await decideSkillProviderPlacement({
    canonicalPath: prepared.canonicalPath,
    destinationPath: path,
    provider,
    previousReceipt: prepared.receipt,
    packageDigest: prepared.manifest.packageDigest,
    filesystem: prepared.request.filesystem ?? nativeSkillInstallFilesystem,
    fileModes: prepared.manifest.files,
    adoptableDigests: prepared.local.adoptableDigests
  })
  const base = { path, role: 'agent' as const, exists: decision.action !== 'create' }
  switch (decision.action) {
    case 'create':
    case 'relink':
      return leaveIfReadOnly({ ...base, action: 'link' }, prepared)
    case 'replace-copy':
      return leaveIfReadOnly({ ...base, action: 'replace' }, prepared)
    case 'keep':
      return { ...base, action: 'keep' }
    case 'skip':
      return {
        ...base,
        action: 'leave',
        reason: PLACEMENT_SKIP_REASONS[decision.code] ?? 'not-installed-by-orca'
      }
  }
}

async function planBundledSkill(prepared: PreparedBundledSkill): Promise<BundledSkillPlan> {
  const shared = await planSharedCopy(prepared)
  const { request } = prepared
  // Why: agent folders are only touched once the shared copy they point at is Orca's.
  const destinations =
    shared.action === 'leave'
      ? []
      : resolveSkillProviderDestinations({
          scope: request.scope,
          homeDirectory: request.homeDirectory,
          workspaceDirectory: request.workspaceDirectory,
          detectedProviders: request.detectedProviders.filter(isSkillInstallProviderId),
          providerRootOverrides:
            request.scope === 'global' ? request.providerRootOverrides : undefined
        }).filter((destination) => !destination.readsCanonicalRoot)
  const agents = await Promise.all(
    destinations.map((destination) =>
      planAgentCopy(prepared, destination.rootPath, destination.provider)
    )
  )
  return {
    name: prepared.entry.name,
    packageDigest: prepared.manifest.packageDigest,
    locations: [shared, ...agents]
  }
}

/** What an install would do to each location, read without writing anything. */
export async function planBundledOrcaSkills(
  names: readonly string[],
  input: BundledOrcaSkillInstallInput
): Promise<BundledSkillPlan[]> {
  const entries = requireBundledPackages(names)
  const context = await bundledInstallContext(input)
  return Promise.all(
    entries.map(async (entry) => planBundledSkill(await prepareBundledSkill(context, entry)))
  )
}

export function bundledOrcaSkillNames(): string[] {
  return BUNDLED_ORCA_SKILL_PACKAGES.map((entry) => entry.name)
}
