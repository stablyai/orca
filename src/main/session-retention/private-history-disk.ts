import { getOrcaUserDataPath } from '../codex/codex-home-paths'
import {
  applyCodexSessionRetention,
  defaultCodexSessionRetentionPolicy,
  DEFAULT_CODEX_SESSION_MAX_BYTES,
  DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS,
  listPrivateCodexSessionRoots,
  MS_PER_DAY,
  snapshotCodexSessionTree,
  type CodexSessionRetentionPolicy
} from './codex-session-retention'
import {
  applyTerminalHistoryRetention,
  DEFAULT_TERMINAL_HISTORY_MAX_BYTES,
  listTerminalHistoryRoots,
  snapshotTerminalHistoryRoot
} from './terminal-history-retention'

export type PrivateHistoryDiskReport = {
  codexSessions: {
    bytes: number
    rolloutFiles: number
    roots: { path: string; bytes: number; rolloutFiles: number }[]
  }
  terminalHistory: {
    bytes: number
    directories: number
    roots: { path: string; bytes: number; directories: number }[]
  }
  policy: {
    maxAgeDays: number
    codexMaxBytes: number
    terminalHistoryMaxBytes: number
  }
}

export type PrivateHistoryClearResult = {
  days: number
  dryRun: boolean
  codex: {
    removedFiles: number
    removedBytes: number
    keptFiles: number
    remainingOverCapBytes: number
  }
  terminalHistory: {
    removedDirectories: number
    removedBytes: number
    skippedReason: 'empty-live-set' | 'unreadable-profiles' | 'no-profiles' | null
  }
}

export async function measurePrivateHistoryDisk(args: {
  codexUserDataPath: string
  historyUserDataPath: string
  now?: number
}): Promise<PrivateHistoryDiskReport> {
  const now = args.now ?? Date.now()
  const codexRoots = listPrivateCodexSessionRoots(args.codexUserDataPath)
  const historyRoots = listTerminalHistoryRoots(args.historyUserDataPath)
  const codex: PrivateHistoryDiskReport['codexSessions']['roots'] = []
  for (const path of codexRoots) {
    const snapshot = await snapshotCodexSessionTree(path)
    codex.push({ path, bytes: snapshot.totalBytes, rolloutFiles: snapshot.rolloutFiles })
  }
  const history: PrivateHistoryDiskReport['terminalHistory']['roots'] = []
  for (const path of historyRoots) {
    const snapshot = await snapshotTerminalHistoryRoot(path, now)
    history.push({ path, bytes: snapshot.totalBytes, directories: snapshot.directories })
  }
  return {
    codexSessions: {
      bytes: codex.reduce((sum, root) => sum + root.bytes, 0),
      rolloutFiles: codex.reduce((sum, root) => sum + root.rolloutFiles, 0),
      roots: codex
    },
    terminalHistory: {
      bytes: history.reduce((sum, root) => sum + root.bytes, 0),
      directories: history.reduce((sum, root) => sum + root.directories, 0),
      roots: history
    },
    policy: {
      maxAgeDays: DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS,
      codexMaxBytes: DEFAULT_CODEX_SESSION_MAX_BYTES,
      terminalHistoryMaxBytes: DEFAULT_TERMINAL_HISTORY_MAX_BYTES
    }
  }
}

export async function clearPrivateHistoryOlderThan(args: {
  codexUserDataPath: string
  historyUserDataPath: string
  days: number
  now?: number
  dryRun?: boolean
  liveWorktreeIds: ReadonlySet<string> | null
  terminalHistorySkipReason?: PrivateHistoryClearResult['terminalHistory']['skippedReason']
}): Promise<PrivateHistoryClearResult> {
  const now = args.now ?? Date.now()
  const policy: CodexSessionRetentionPolicy = {
    ...defaultCodexSessionRetentionPolicy(now),
    maxAgeMs: args.days * MS_PER_DAY,
    // The explicit command is an age cutoff. The startup pass applies the size cap.
    maxBytes: Number.POSITIVE_INFINITY
  }
  let removedFiles = 0
  let removedBytes = 0
  let keptFiles = 0
  let remainingOverCapBytes = 0
  for (const sessionsDir of listPrivateCodexSessionRoots(args.codexUserDataPath)) {
    const result = await applyCodexSessionRetention({
      sessionsDir,
      policy,
      dryRun: args.dryRun
    })
    removedFiles += result.removedFiles
    removedBytes += result.removedBytes
    keptFiles += result.keptFiles
    remainingOverCapBytes += result.remainingOverCapBytes
  }
  const terminalHistory = await clearTerminalHistoryOlderThan({
    historyUserDataPath: args.historyUserDataPath,
    days: args.days,
    now,
    dryRun: args.dryRun,
    liveWorktreeIds: args.liveWorktreeIds,
    skippedReason: args.terminalHistorySkipReason ?? null
  })
  return {
    days: args.days,
    dryRun: args.dryRun === true,
    codex: { removedFiles, removedBytes, keptFiles, remainingOverCapBytes },
    terminalHistory
  }
}

async function clearTerminalHistoryOlderThan(args: {
  historyUserDataPath: string
  days: number
  now: number
  dryRun?: boolean
  liveWorktreeIds: ReadonlySet<string> | null
  skippedReason: PrivateHistoryClearResult['terminalHistory']['skippedReason']
}): Promise<PrivateHistoryClearResult['terminalHistory']> {
  if (args.skippedReason || args.liveWorktreeIds === null) {
    return {
      removedDirectories: 0,
      removedBytes: 0,
      skippedReason: args.skippedReason ?? 'no-profiles'
    }
  }
  let removedDirectories = 0
  let removedBytes = 0
  let skippedReason: PrivateHistoryClearResult['terminalHistory']['skippedReason'] = null
  for (const historyRoot of listTerminalHistoryRoots(args.historyUserDataPath)) {
    const result = await applyTerminalHistoryRetention({
      historyRoot,
      liveWorktreeIds: args.liveWorktreeIds,
      now: args.now,
      maxAgeMs: args.days * MS_PER_DAY,
      maxBytes: Number.POSITIVE_INFINITY,
      dryRun: args.dryRun
    })
    removedDirectories += result.removedDirectories
    removedBytes += result.removedBytes
    if (result.skippedReason) {
      skippedReason = result.skippedReason
    }
  }
  return { removedDirectories, removedBytes, skippedReason }
}

export function formatByteSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1)
  return `${shown} ${units[unit]}`
}

export function formatPrivateHistoryDisk(report: PrivateHistoryDiskReport): string {
  const codexLines = [
    'Private Codex sessions',
    `  on disk: ${formatByteSize(report.codexSessions.bytes)} (${report.codexSessions.rolloutFiles} rollout files)`,
    `  policy: keep ${report.policy.maxAgeDays} days, cap ${formatByteSize(report.policy.codexMaxBytes)}`
  ]
  if (report.codexSessions.roots.length === 0) {
    codexLines.push('  roots: none yet')
  } else {
    for (const root of report.codexSessions.roots) {
      codexLines.push(`  ${formatByteSize(root.bytes)}  ${root.path}`)
    }
  }
  const historyLines = [
    'Terminal history',
    `  on disk: ${formatByteSize(report.terminalHistory.bytes)} (${report.terminalHistory.directories} directories)`,
    `  policy: after the worktree is gone, keep ${report.policy.maxAgeDays} days, cap ${formatByteSize(report.policy.terminalHistoryMaxBytes)}`
  ]
  if (report.terminalHistory.roots.length === 0) {
    historyLines.push('  roots: none yet')
  } else {
    for (const root of report.terminalHistory.roots) {
      historyLines.push(`  ${formatByteSize(root.bytes)}  ${root.path}`)
    }
  }
  return [
    ...codexLines,
    '',
    ...historyLines,
    '',
    'Clear files older than a cutoff with: orca diagnostics clear-history-older-than --days 30'
  ].join('\n')
}

export function formatPrivateHistoryClear(result: PrivateHistoryClearResult): string {
  const prefix = result.dryRun ? 'Would remove' : 'Removed'
  const lines = [
    `${prefix} ${result.codex.removedFiles} Codex rollout files (${formatByteSize(result.codex.removedBytes)}). Kept ${result.codex.keptFiles} newer rollouts.`,
    result.terminalHistory.skippedReason
      ? `Terminal history was left in place (${result.terminalHistory.skippedReason}).`
      : `${prefix} ${result.terminalHistory.removedDirectories} terminal-history directories whose worktrees are gone (${formatByteSize(result.terminalHistory.removedBytes)}).`
  ]
  return lines.join('\n')
}

export function localPrivateHistoryPaths(): {
  codexUserDataPath: string
  historyUserDataPath: string
} {
  const userDataPath = getOrcaUserDataPath()
  return { codexUserDataPath: userDataPath, historyUserDataPath: userDataPath }
}
