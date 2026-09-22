import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import { writeSkillStateFile, type SkillInstallReceiptV1 } from './skill-install-provenance'
import {
  skillPlacementJournalPath,
  type SkillPlacementJournalV1
} from './skill-placement-recovery-journal'
import {
  finishSkillPlacementTransaction,
  recoverSkillPlacementTransaction
} from './skill-placement-transaction'
import {
  resolveSkillProviderDestinations,
  type SkillProviderDestination,
  type SkillProviderRootOverrides
} from './skill-provider-destinations'

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function createSkillPlacementTransaction(input: {
  stateDirectory: string
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  detectedProviders: readonly string[]
  providerRootOverrides?: SkillProviderRootOverrides
  filesystem?: SkillInstallFilesystem
  wslDistro?: string
  signal?: AbortSignal
}): {
  prepare(previous: SkillInstallReceiptV1 | null, receipt: SkillInstallReceiptV1): Promise<void>
  commit(receipt: SkillInstallReceiptV1): Promise<SkillInstallReceiptV1>
  finish(receipt: SkillInstallReceiptV1): Promise<void>
} {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const providerRootOverrides =
    input.scope === 'global' &&
    input.providerRootOverrides &&
    Object.keys(input.providerRootOverrides).length > 0
      ? input.providerRootOverrides
      : undefined
  let canonicalPath: string | null = null
  return {
    async prepare(previous, receipt) {
      canonicalPath = receipt.canonicalPath
      const selected = new Set(input.detectedProviders.filter(isSkillInstallProviderId))
      const destinations = resolveSkillProviderDestinations({
        scope: input.scope,
        homeDirectory: input.homeDirectory,
        workspaceDirectory: input.workspaceDirectory,
        detectedProviders: [...selected],
        providerRootOverrides
      }).filter((destination) => !destination.readsCanonicalRoot)
      const desiredPathByProvider = new Map(
        destinations.map((destination) => [
          destination.provider,
          normalizedPath(destination.rootPath)
        ])
      )
      for (const placement of previous?.placements ?? []) {
        if (
          !isSkillInstallProviderId(placement.provider) ||
          placement.topology === 'canonical-copy' ||
          placement.status === 'failed' ||
          placement.status === 'skipped'
        ) {
          continue
        }
        const claimedBy = destinations.find(
          (destination) =>
            normalizedPath(destination.rootPath) === normalizedPath(dirname(placement.path))
        )
        if (claimedBy && claimedBy.provider !== placement.provider) {
          throw new Error('skill-install-provider-root-ownership-conflict')
        }
      }
      const previousDestinationKeys = new Set<string>()
      const previousDestinations: SkillProviderDestination[] =
        previous?.placements.flatMap((placement) => {
          if (!isSkillInstallProviderId(placement.provider)) {
            return []
          }
          if (placement.status === 'failed' || placement.status === 'skipped') {
            return []
          }
          const rootPath = dirname(placement.path)
          const key = `${placement.provider}:${normalizedPath(rootPath)}`
          if (
            placement.topology === 'canonical-copy' ||
            desiredPathByProvider.get(placement.provider) === normalizedPath(rootPath) ||
            previousDestinationKeys.has(key)
          ) {
            return []
          }
          previousDestinationKeys.add(key)
          return [{ provider: placement.provider, readsCanonicalRoot: false, rootPath }]
        }) ?? []
      const id = randomUUID()
      const name = basename(receipt.canonicalPath)
      const journal: SkillPlacementJournalV1 = {
        schemaVersion: 1,
        operation: 'place',
        canonicalPath: receipt.canonicalPath,
        packageDigest: receipt.packageDigest,
        fileModes: receipt.fileModes ?? [],
        receipt: { ...receipt, providers: [...selected] },
        previousReceipt: previous,
        providers: [...selected],
        actions: [...destinations, ...previousDestinations].map((destination) => ({
          provider: destination.provider,
          destinationPath: join(destination.rootPath, name),
          rootPath: destination.rootPath,
          desired: destinations.includes(destination),
          stagingPath: join(destination.rootPath, `.${name}.orca-placement-staging-${id}`),
          backupPath: join(destination.rootPath, `.${name}.orca-placement-backup-${id}`)
        })),
        ...(providerRootOverrides ? { providerRootOverrides } : {}),
        ...(input.wslDistro ? { wslDistro: input.wslDistro } : {})
      }
      await writeSkillStateFile(
        skillPlacementJournalPath(input.stateDirectory, receipt.canonicalPath),
        journal
      )
    },
    async commit(receipt) {
      if (canonicalPath !== receipt.canonicalPath) {
        throw new Error('skill-placement-transaction-not-prepared')
      }
      return (
        (await recoverSkillPlacementTransaction(
          input.stateDirectory,
          receipt.canonicalPath,
          filesystem,
          { finalize: false, signal: input.signal }
        )) ?? receipt
      )
    },
    async finish(receipt) {
      await finishSkillPlacementTransaction(input.stateDirectory, receipt.canonicalPath, filesystem)
    }
  }
}
