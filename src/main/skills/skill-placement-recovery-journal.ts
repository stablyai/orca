import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import type { SkillInstalledFileMode } from './skill-install-filesystem'
import { skillInstallStateKey, type SkillInstallReceiptV1 } from './skill-install-provenance'
import {
  resolveSkillProviderDestinations,
  type SkillProviderRootOverrides
} from './skill-provider-destinations'

const JOURNAL_MAX_BYTES = 4 * 1024 * 1024

export type SkillPlacementJournalActionV1 = {
  provider: string
  destinationPath: string
  rootPath: string
  desired: boolean
  stagingPath: string
  backupPath: string
}

export type SkillPlacementJournalV1 = {
  schemaVersion: 1
  operation: 'place'
  canonicalPath: string
  packageDigest: string
  fileModes: SkillInstalledFileMode[]
  receipt: SkillInstallReceiptV1
  previousReceipt: SkillInstallReceiptV1 | null
  providers: string[]
  providerRootOverrides?: SkillProviderRootOverrides
  actions: SkillPlacementJournalActionV1[]
  wslDistro?: string
}

export function skillPlacementJournalPath(stateDirectory: string, canonicalPath: string): string {
  return join(stateDirectory, 'placement-journals', `${skillInstallStateKey(canonicalPath)}.json`)
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function scopeRoot(canonicalPath: string): string | null {
  const skills = dirname(canonicalPath)
  const agents = dirname(skills)
  return basename(skills) === 'skills' && basename(agents) === '.agents' ? dirname(agents) : null
}

function validFileModes(value: unknown): value is SkillInstalledFileMode[] {
  if (!Array.isArray(value)) {
    return false
  }
  const paths = value.map((entry) =>
    entry && typeof entry === 'object' && 'path' in entry ? (entry as { path: unknown }).path : null
  )
  return (
    paths.every(
      (path) =>
        typeof path === 'string' &&
        path.length > 0 &&
        path.length <= 4096 &&
        !path.includes('\0') &&
        !path.startsWith('/') &&
        !path.split(/[\\/]/u).includes('..')
    ) &&
    new Set(paths).size === paths.length &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { executable?: unknown }).executable === 'boolean'
    )
  )
}

function validProviderRootOverrides(value: unknown): value is SkillProviderRootOverrides {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.entries(value).every(
    ([provider, root]) =>
      (provider === 'claude' || provider === 'grok') &&
      typeof root === 'string' &&
      root.length > 0 &&
      root.length <= 32_768 &&
      !root.includes('\0') &&
      isAbsolute(root)
  )
}

function isJournal(value: unknown, canonicalPath: string): value is SkillPlacementJournalV1 {
  if (!value || typeof value !== 'object') {
    return false
  }
  const journal = value as Partial<SkillPlacementJournalV1>
  if (
    journal.schemaVersion !== 1 ||
    journal.operation !== 'place' ||
    journal.canonicalPath !== canonicalPath ||
    !journal.receipt ||
    journal.receipt.canonicalPath !== canonicalPath ||
    journal.packageDigest !== journal.receipt.packageDigest ||
    !/^[a-f0-9]{64}$/u.test(journal.packageDigest ?? '') ||
    typeof journal.receipt.packageId !== 'string' ||
    typeof journal.receipt.versionId !== 'string' ||
    (journal.receipt.scope !== 'global' && journal.receipt.scope !== 'workspace') ||
    !Array.isArray(journal.receipt.placements) ||
    !validFileModes(journal.fileModes) ||
    !Array.isArray(journal.providers) ||
    !journal.providers.every(isSkillInstallProviderId) ||
    new Set(journal.providers).size !== journal.providers.length ||
    !validProviderRootOverrides(journal.providerRootOverrides) ||
    (journal.providerRootOverrides !== undefined && journal.receipt.scope !== 'global') ||
    !Array.isArray(journal.actions) ||
    !journal.actions.every(
      (action) =>
        action &&
        typeof action.provider === 'string' &&
        typeof action.destinationPath === 'string' &&
        typeof action.rootPath === 'string' &&
        typeof action.desired === 'boolean' &&
        typeof action.stagingPath === 'string' &&
        typeof action.backupPath === 'string'
    ) ||
    (journal.previousReceipt !== null &&
      journal.previousReceipt?.canonicalPath !== canonicalPath) ||
    (journal.wslDistro !== undefined && typeof journal.wslDistro !== 'string')
  ) {
    return false
  }
  const root = scopeRoot(canonicalPath)
  if (!root) {
    return false
  }
  const destinations = resolveSkillProviderDestinations({
    scope: journal.receipt.scope,
    homeDirectory: root,
    ...(journal.receipt.scope === 'workspace' ? { workspaceDirectory: root } : {}),
    detectedProviders: journal.providers,
    providerRootOverrides: journal.providerRootOverrides
  }).filter((destination) => !destination.readsCanonicalRoot)
  const desiredByProvider = new Map(
    destinations.map((destination) => [destination.provider, destination])
  )
  const normalizedActionPaths = journal.actions.flatMap((action) => [
    normalizedPath(action.destinationPath),
    normalizedPath(action.stagingPath),
    normalizedPath(action.backupPath)
  ])
  return (
    new Set(normalizedActionPaths).size === normalizedActionPaths.length &&
    journal.actions.every((action) => {
      const desiredDestination = desiredByProvider.get(action.provider as never)
      const previousPlacement = journal.previousReceipt?.placements.find(
        (placement) =>
          placement.provider === action.provider &&
          normalizedPath(placement.path) === normalizedPath(action.destinationPath)
      )
      const destination = action.desired
        ? desiredDestination
        : previousPlacement
          ? {
              provider: action.provider,
              rootPath: dirname(previousPlacement.path),
              readsCanonicalRoot: false
            }
          : undefined
      const name = basename(canonicalPath)
      return Boolean(
        destination &&
        action.rootPath === destination.rootPath &&
        (action.desired
          ? Boolean(desiredDestination)
          : Boolean(
              previousPlacement &&
              (!desiredDestination ||
                normalizedPath(desiredDestination.rootPath) !== normalizedPath(action.rootPath))
            )) &&
        normalizedPath(action.destinationPath) ===
          normalizedPath(join(destination.rootPath, name)) &&
        dirname(action.stagingPath) === dirname(action.destinationPath) &&
        dirname(action.backupPath) === dirname(action.destinationPath) &&
        basename(action.stagingPath).startsWith(`.${name}.orca-placement-staging-`) &&
        basename(action.backupPath).startsWith(`.${name}.orca-placement-backup-`) &&
        action.stagingPath !== action.backupPath
      )
    })
  )
}

export async function readSkillPlacementRecoveryJournal(
  stateDirectory: string,
  canonicalPath: string
): Promise<SkillPlacementJournalV1 | null> {
  try {
    const value: unknown = JSON.parse(
      (
        await readNodeFileWithinLimit(
          skillPlacementJournalPath(stateDirectory, canonicalPath),
          JOURNAL_MAX_BYTES
        )
      ).buffer.toString('utf8')
    )
    if (!isJournal(value, canonicalPath)) {
      throw new Error('skill-placement-journal-invalid')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}
