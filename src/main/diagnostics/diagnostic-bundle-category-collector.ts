import os from 'node:os'
import { app } from 'electron'
import type {
  DiagnosticBundleCategory,
  DiagnosticBundleCategoryResult
} from '../../shared/diagnostic-bundle-export-types'
import { collectMemorySnapshot, type MemorySnapshotStore } from '../memory/collector'
import { collectDiagnosticBundle, getDiagnosticsStatus } from '../observability'
import { CrashReportStore } from '../crash-reporting/crash-report-store'
import { collectAppDiagnosticSummary } from './app-diagnostic-summary'
import type { DiagnosticArchiveEntry } from './diagnostic-archive-writer'
import {
  collectDiagnosticJsonCategory,
  makeDiagnosticJsonContent,
  sanitizeDiagnosticCategoryError
} from './diagnostic-bundle-json-category'
import { collectSystemDiagnosticSummary } from './system-diagnostic-summary'
import {
  collectRuntimeDiagnosticCounts,
  type DiagnosticRuntimeStore
} from './runtime-diagnostic-counts'
import { collectTerminalLifecycleDiagnosticTrace } from './terminal-lifecycle-diagnostic-trace'
import { collectNativeMinidumpCategory } from './diagnostic-bundle-native-minidumps'
import { collectWindowsEventDiagnosticSummary } from './windows-event-diagnostic-summary'
import { collectWindowsWslDiagnosticSummary } from './windows-wsl-diagnostic-summary'
import { collectShellAvailabilitySummary } from './shell-availability-summary'
import { collectMacosReportDiagnosticIndex } from './macos-report-diagnostic-index'
import {
  collectLinuxCoredumpDiagnosticSummary,
  collectLinuxJournalDiagnosticSummary
} from './linux-coredump-diagnostic-summary'

export type DiagnosticBundleRuntimeStore = DiagnosticRuntimeStore & MemorySnapshotStore

type CategoryEntryAdder = (
  category: DiagnosticBundleCategory,
  path: string,
  content: Buffer | string
) => void
type CategoryResultRecorder = (result: DiagnosticBundleCategoryResult) => void

type DiagnosticBundleCategoryCollectorContext = {
  store: DiagnosticBundleRuntimeStore
  lookbackMinutes: number
  orcaChannel: 'stable' | 'rc' | 'dev'
  addEntry: (entry: DiagnosticArchiveEntry) => void
  record: CategoryResultRecorder
}

export async function collectDiagnosticBundleCategory(
  category: DiagnosticBundleCategory,
  context: DiagnosticBundleCategoryCollectorContext
): Promise<void> {
  const addEntry = (
    entryCategory: DiagnosticBundleCategory,
    path: string,
    content: Buffer | string
  ): void => {
    context.addEntry({ category: entryCategory, path, content })
  }

  switch (category) {
    case 'app':
      await collectDiagnosticJsonCategory(context.record, addEntry, category, 'app/orca.json', () =>
        collectAppDiagnosticSummary()
      )
      break
    case 'system':
      await collectSystemCategory(context.record, addEntry)
      break
    case 'observability':
      await collectObservabilityCategory(
        context.record,
        addEntry,
        context.lookbackMinutes,
        context.orcaChannel
      )
      break
    case 'memory':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'memory/snapshot.json',
        () => collectMemorySnapshot(context.store)
      )
      break
    case 'crash-reports':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'crash/orca-crash-reports.json',
        () => CrashReportStore.fromUserData().listRecent()
      )
      break
    case 'native-minidumps':
      await collectNativeMinidumpCategory(context.record, addEntry, context.lookbackMinutes)
      break
    case 'runtime-counts':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'app/runtime-counts.json',
        () => collectRuntimeDiagnosticCounts(context.store)
      )
      break
    case 'terminal-lifecycle':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'crash/terminal-lifecycle.json',
        () => collectTerminalLifecycleDiagnosticTrace()
      )
      break
    case 'windows-events':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'windows/events.json',
        () => collectWindowsEventDiagnosticSummary(context.lookbackMinutes)
      )
      break
    case 'windows-wsl':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'windows/wsl.json',
        () => collectWindowsWslDiagnosticSummary()
      )
      break
    case 'windows-shells':
      await collectShellCategory(context.record, addEntry, category, 'windows/shells.json', 'win32')
      break
    case 'macos-reports':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'macos/reports-index.json',
        () => collectMacosReportDiagnosticIndex(context.lookbackMinutes)
      )
      break
    case 'macos-shells':
      await collectShellCategory(context.record, addEntry, category, 'macos/shells.json', 'darwin')
      break
    case 'linux-coredump':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'linux/coredumpctl.json',
        () => collectLinuxCoredumpDiagnosticSummary(context.lookbackMinutes)
      )
      break
    case 'linux-journal':
      await collectDiagnosticJsonCategory(
        context.record,
        addEntry,
        category,
        'linux/journal.json',
        () => collectLinuxJournalDiagnosticSummary(context.lookbackMinutes)
      )
      break
    case 'linux-shells':
      await collectShellCategory(context.record, addEntry, category, 'linux/shells.json', 'linux')
      break
  }
}

async function collectShellCategory(
  record: CategoryResultRecorder,
  addEntry: CategoryEntryAdder,
  category: DiagnosticBundleCategory,
  path: string,
  platform: NodeJS.Platform
): Promise<void> {
  await collectDiagnosticJsonCategory(record, addEntry, category, path, () =>
    process.platform === platform
      ? collectShellAvailabilitySummary(platform)
      : { supported: false, reason: unsupportedPlatformReason(platform) }
  )
}

function unsupportedPlatformReason(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'not_windows' : platform === 'darwin' ? 'not_macos' : 'not_linux'
}

async function collectSystemCategory(
  record: CategoryResultRecorder,
  addEntry: CategoryEntryAdder
): Promise<void> {
  try {
    const summary = collectSystemDiagnosticSummary()
    const osPath = 'system/os.json'
    const resourcesPath = 'system/resources.json'
    addEntry(
      'system',
      osPath,
      makeDiagnosticJsonContent({
        platform: summary.platform,
        arch: summary.arch,
        osRelease: summary.osRelease,
        osVersion: summary.osVersion,
        systemVersion: summary.systemVersion,
        locale: summary.locale
      })
    )
    addEntry(
      'system',
      resourcesPath,
      makeDiagnosticJsonContent({
        cpu: summary.cpu,
        memory: summary.memory,
        loadAverage1m: summary.loadAverage1m
      })
    )
    record({ category: 'system', status: 'included', files: [osPath, resourcesPath] })
  } catch (error) {
    record({
      category: 'system',
      status: 'error',
      reason: sanitizeDiagnosticCategoryError(error),
      files: []
    })
  }
}

async function collectObservabilityCategory(
  record: CategoryResultRecorder,
  addEntry: CategoryEntryAdder,
  lookbackMinutes: number,
  orcaChannel: 'stable' | 'rc' | 'dev'
): Promise<void> {
  const category = 'observability'
  const path = 'diagnostics/observability.ndjson'
  try {
    const status = getDiagnosticsStatus()
    if (!status.bundleEnabled) {
      record({
        category,
        status: 'skipped',
        reason: status.disabledReason ?? 'diagnostics_bundle_disabled',
        files: []
      })
      return
    }
    const bundle = collectDiagnosticBundle({
      appVersion: app.getVersion(),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      orcaChannel,
      lookbackMinutes
    })
    addEntry(category, path, bundle.payload)
    record({ category, status: 'included', files: [path] })
  } catch (error) {
    record({ category, status: 'error', reason: sanitizeDiagnosticCategoryError(error), files: [] })
  }
}
