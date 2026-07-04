import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import type {
  DiagnosticBundleCategoryResult,
  DiagnosticBundleExportArgs,
  DiagnosticBundleExportResult,
  DiagnosticBundleManifest
} from '../../shared/diagnostic-bundle-export-types'
import { resolveDiagnosticOrcaChannel } from '../observability/diagnostic-upload-endpoint'
import {
  resolveDiagnosticBundleCategories,
  parseDiagnosticBundleCategories
} from './diagnostic-bundle-category'
import {
  collectDiagnosticBundleCategory,
  type DiagnosticBundleRuntimeStore
} from './diagnostic-bundle-category-collector'
import { resolveDiagnosticBundleOutputPath } from './diagnostic-output-path'
import { writeDiagnosticArchive, type DiagnosticArchiveEntry } from './diagnostic-archive-writer'

const DEFAULT_LOOKBACK_MINUTES = 30

export async function exportDiagnosticBundle(
  args: DiagnosticBundleExportArgs & { store: DiagnosticBundleRuntimeStore }
): Promise<DiagnosticBundleExportResult> {
  const outputPath = resolveDiagnosticBundleOutputPath(args.output)
  const lookbackMinutes = normalizeLookbackMinutes(args.lookbackMinutes)
  const selectedCategories = resolveDiagnosticBundleCategories({
    include: args.include ? parseDiagnosticBundleCategories(args.include) : undefined,
    exclude: args.exclude ? parseDiagnosticBundleCategories(args.exclude) : undefined
  })

  const entries: DiagnosticArchiveEntry[] = []
  const categoryResults: DiagnosticBundleCategoryResult[] = []
  const collectedAt = new Date().toISOString()
  const orcaChannel = resolveDiagnosticOrcaChannel()
  const bundleId = randomUUID()

  const addEntry = (entry: DiagnosticArchiveEntry): void => {
    entries.push(entry)
  }
  const record = (result: DiagnosticBundleCategoryResult): void => {
    categoryResults.push(result)
  }

  for (const category of selectedCategories) {
    await collectDiagnosticBundleCategory(category, {
      store: args.store,
      lookbackMinutes,
      orcaChannel,
      addEntry,
      record
    })
  }

  const manifest: Omit<DiagnosticBundleManifest, 'files'> = {
    schemaVersion: 1,
    bundleId,
    collectedAt,
    appVersion: app.getVersion(),
    orcaChannel,
    platform: process.platform,
    arch: process.arch,
    lookbackMinutes,
    categories: categoryResults
  }
  const archive = await writeDiagnosticArchive({ outputPath, manifest, entries })

  if (args.open) {
    shell.showItemInFolder(outputPath)
  }

  return {
    bundleId,
    outputPath,
    bytes: archive.bytes,
    includedCategories: categoryResults
      .filter((result) => result.status === 'included' || result.status === 'truncated')
      .map((result) => result.category),
    skippedCategories: categoryResults.filter((result) => result.status === 'skipped'),
    errorCategories: categoryResults.filter((result) => result.status === 'error'),
    fileCount: archive.manifest.files.length
  }
}

function normalizeLookbackMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOOKBACK_MINUTES
  }
  return Math.max(1, Math.floor(value))
}
