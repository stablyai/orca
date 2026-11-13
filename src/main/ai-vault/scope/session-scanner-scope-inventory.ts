import { extname, join } from 'node:path'
import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import type { AiVaultScanIssue } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { wslGatedReaddir } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import { openAiVaultScanSource } from '../scan-lifecycle/ai-vault-scan-progress'
import { SCAN_ISSUE_LIMIT, recordSessionScanIssue } from '../parsing/session-scan-issues'
import { createAiVaultScopeCwdMatcher } from '../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import type { CwdBucketLayout } from './session-cwd-bucket-layouts'
import type { FileWithMtime } from '../session-scanner-types'
import {
  cachedProjectDirCwd,
  cwdBucketScopePrefixes,
  listProjectDirs,
  collectBucketFiles,
  recordRefusal,
  type IssueSink
} from './session-scanner-scope-discovery'

const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl'])
export type CwdBucketInventory = {
  layout: CwdBucketLayout
  // With no recency pass behind it, files a cwd probe can't place are kept for the parse to decide.
  scopeOnly: boolean
  // unverified: a scope-only Claude bucket whose newest transcripts named no in-scope cwd.
  directories: { paths: string[]; unverified: boolean }[]
  issues: { before: number; issue: AiVaultScanIssue }[]
}

export async function yieldScanInventory(index: number, signal?: AbortSignal): Promise<void> {
  if (index % 256 === 0) {
    await yieldToEventLoop()
  }
  throwIfAiVaultScanCancelled(signal)
}

type InScopeDiscoveryArgs = {
  rootDirs: readonly string[]
  scopePaths: readonly string[]
  limit: number
  excludedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
  scopeOnly?: boolean
  signal?: AbortSignal
}

export async function discoverInScopeCwdBucketFiles(
  layout: CwdBucketLayout,
  args: InScopeDiscoveryArgs
): Promise<FileWithMtime[]> {
  const inventory = await inventoryCwdBucketFiles(layout, args)
  return selectCwdBucketFiles(inventory, args)
}

/** Freeze names only; winner-dependent header/stat decisions remain in selection. */
export async function inventoryCwdBucketFiles(
  layout: CwdBucketLayout,
  args: Omit<InScopeDiscoveryArgs, 'excludedFilePaths' | 'issues'>,
  issueLimit = SCAN_ISSUE_LIMIT
): Promise<CwdBucketInventory> {
  const inventory: CwdBucketInventory = {
    layout,
    scopeOnly: args.scopeOnly === true,
    directories: [],
    issues: []
  }
  if (args.scopePaths.length === 0 || args.limit <= 0) {
    return inventory
  }
  const record: IssueSink = (issue) => {
    if (inventory.issues.length < issueLimit) {
      inventory.issues.push({ before: inventory.directories.length, issue })
    }
  }
  const prefixes = cwdBucketScopePrefixes(layout, args.scopePaths)
  const inScope = createAiVaultScopeCwdMatcher(args.scopePaths)
  let index = 0
  for (const rootDir of args.rootDirs.flatMap(layout.bucketDirs ?? ((dir) => [dir]))) {
    throwIfAiVaultScanCancelled(args.signal)
    let close: () => void = () => undefined
    try {
      const directories = await listProjectDirs(
        layout,
        rootDir,
        prefixes,
        record,
        args.signal,
        () => {
          close = openAiVaultScanSource(args.signal, layout.agent)
        }
      )
      for (const directory of directories) {
        await yieldScanInventory(index++, args.signal)
        let unverified = false
        if (layout.agent === 'claude') {
          const cwd = await cachedProjectDirCwd(directory, record, layout.agent, args.signal)
          // No cwd found, or a folder sharing the lossy name: without a recency pass, the parse decides.
          if (!inScope(cwd, directory)) {
            if (!args.scopeOnly) {
              continue
            }
            unverified = true
          }
        }
        const paths: string[] = []
        try {
          const entries = await wslGatedReaddir(directory, 'scan', args.signal)
          for (const entry of entries) {
            await yieldScanInventory(index++, args.signal)
            if (entry.isFile() && TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
              paths.push(join(directory, entry.name))
            }
          }
        } catch (err) {
          throwIfAiVaultScanCancelled(args.signal)
          recordRefusal(record, directory, err, layout.agent)
        }
        inventory.directories.push({ paths, unverified })
      }
    } finally {
      close()
    }
  }
  return inventory
}

/** Replay selection with diagnostics in discovery order. */
export async function selectCwdBucketFiles(
  inventory: CwdBucketInventory,
  args: Pick<
    InScopeDiscoveryArgs,
    'scopePaths' | 'limit' | 'excludedFilePaths' | 'issues' | 'signal'
  >
): Promise<FileWithMtime[]> {
  const { layout } = inventory
  const collected = new Map<string, FileWithMtime>()
  // Bounded apart so files the parse may reject never push out ones already known to be in scope.
  const unverified = new Map<string, FileWithMtime>()
  const record: IssueSink = (issue) => recordSessionScanIssue(args.issues, issue)
  const inScope = createAiVaultScopeCwdMatcher(args.scopePaths)
  let issueIndex = 0
  for (let index = 0; index <= inventory.directories.length; index++) {
    await yieldScanInventory(index, args.signal)
    while (inventory.issues[issueIndex]?.before === index) {
      record(inventory.issues[issueIndex++].issue)
    }
    const directory = inventory.directories[index]
    if (!directory) {
      break
    }
    await collectBucketFiles({
      paths: directory.paths,
      agent: layout.agent,
      inScope: layout.agent !== 'claude' ? inScope : undefined,
      issues: record,
      collected: directory.unverified ? unverified : collected,
      ...(inventory.scopeOnly ? { unknown: unverified } : {}),
      limit: args.limit,
      excludedFilePaths: args.excludedFilePaths,
      signal: args.signal
    })
  }
  inventory.directories.length = 0
  inventory.issues.length = 0
  return [...collected.values(), ...unverified.values()].sort(
    (left, right) => right.mtimeMs - left.mtimeMs
  )
}
