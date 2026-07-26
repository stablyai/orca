import { opendir, stat } from 'node:fs/promises'
import { basename, delimiter, extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import {
  AiVaultSessionDiscoveryBudget,
  AiVaultSessionDiscoveryCapacityError,
  type AiVaultSessionDiscoveryLimits
} from './session-discovery-budget'

const AI_VAULT_DISCOVERY_ISSUE_MAX = 256

export async function discoverFiles(args: {
  rootDir: string
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
  directoryPredicate?: (name: string, depth: number) => boolean
  limits?: Partial<AiVaultSessionDiscoveryLimits>
}): Promise<SessionFileDiscovery> {
  const files: FileWithMtime[] = []
  const limit = Math.max(0, Math.floor(args.limit))
  if (limit > 0) {
    try {
      await visitSessionFiles(
        args.rootDir,
        {
          extensions: new Set(args.extensions),
          filePredicate: args.filePredicate,
          directoryPredicate: args.directoryPredicate
        },
        async (path) => {
          try {
            const fileStat = await stat(path)
            retainNewestFile(files, limit, {
              path,
              mtimeMs: fileStat.mtimeMs,
              modifiedAt: fileStat.mtime.toISOString(),
              sizeBytes: fileStat.size,
              dev: fileStat.dev,
              ino: fileStat.ino,
              nlink: fileStat.nlink
            })
          } catch (err) {
            addDiscoveryIssue(args.issues, args.agent, path, errorMessage(err))
          }
          return true
        },
        new AiVaultSessionDiscoveryBudget(args.limits)
      )
    } catch (error) {
      if (error instanceof AiVaultSessionDiscoveryCapacityError) {
        addDiscoveryIssue(args.issues, args.agent, args.rootDir, error.message)
      } else {
        throw error
      }
    }
  }
  return { agent: args.agent, rootDir: args.rootDir, files }
}

type SessionFileTraversalOptions = {
  extensions: Set<string>
  filePredicate?: (path: string) => boolean
  directoryPredicate?: (name: string, depth: number) => boolean
}

export async function findFirstSessionFile(
  dirPath: string,
  options: SessionFileTraversalOptions
): Promise<string | null> {
  let found: string | null = null
  try {
    await visitSessionFiles(
      dirPath,
      options,
      async (path) => {
        found = path
        return false
      },
      new AiVaultSessionDiscoveryBudget()
    )
  } catch (error) {
    if (!(error instanceof AiVaultSessionDiscoveryCapacityError)) {
      throw error
    }
  }
  return found
}

function addDiscoveryIssue(
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent,
  path: string,
  message: string
): void {
  if (issues.length < AI_VAULT_DISCOVERY_ISSUE_MAX) {
    issues.push({ agent, path, message })
  }
}

function retainNewestFile(files: FileWithMtime[], limit: number, file: FileWithMtime): void {
  let low = 0
  let high = files.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((files[middle]?.mtimeMs ?? Number.NEGATIVE_INFINITY) >= file.mtimeMs) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  if (low >= limit) {
    return
  }
  files.splice(low, 0, file)
  if (files.length > limit) {
    files.pop()
  }
}

export async function discoverOpenClawFiles(args: {
  rootDirs: string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const files: FileWithMtime[] = []
  const limit = Math.max(0, Math.floor(args.limit))
  for (const rootDir of args.rootDirs) {
    const discovery = await discoverFiles({
      rootDir: basename(rootDir) === 'agents' ? rootDir : join(rootDir, 'agents'),
      limit,
      agent: 'openclaw',
      issues: args.issues,
      extensions: ['.jsonl'],
      filePredicate: (path) => path.split(/[\\/]/).includes('sessions')
    })
    for (const file of discovery.files) {
      retainNewestFile(files, limit, file)
    }
  }
  return { agent: 'openclaw', rootDir: args.rootDirs.join(delimiter), files }
}

async function visitSessionFiles(
  dirPath: string,
  options: SessionFileTraversalOptions,
  visitFile: (path: string) => Promise<boolean>,
  budget: AiVaultSessionDiscoveryBudget,
  depth = 0
): Promise<boolean> {
  budget.enterDirectory(depth)
  let directory
  try {
    directory = await opendir(dirPath)
  } catch {
    return true
  }

  const tasks: { kind: 'directory' | 'file'; path: string }[] = []
  let capacityError: AiVaultSessionDiscoveryCapacityError | null = null
  try {
    while (true) {
      let entry
      try {
        entry = await directory.read()
      } catch {
        // A disappearing directory has no safe remainder to visit.
        break
      }
      if (!entry) {
        break
      }
      const fullPath = join(dirPath, entry.name)
      try {
        budget.visitEntry(fullPath)
      } catch (error) {
        if (error instanceof AiVaultSessionDiscoveryCapacityError) {
          capacityError = error
          break
        }
        throw error
      }
      if (entry.isDirectory()) {
        // Skip whole subtrees an agent never wants (e.g. subagent transcripts),
        // avoiding the directory-read cost of descending into them.
        if (options.directoryPredicate?.(entry.name, depth) ?? true) {
          tasks.push({ kind: 'directory', path: fullPath })
        }
        continue
      }
      if (
        entry.isFile() &&
        options.extensions.has(extname(entry.name).toLowerCase()) &&
        (options.filePredicate?.(fullPath) ?? true)
      ) {
        tasks.push({ kind: 'file', path: fullPath })
      }
    }
  } finally {
    await directory.close().catch(() => undefined)
  }

  for (const task of tasks) {
    const shouldContinue =
      task.kind === 'directory'
        ? await visitSessionFiles(task.path, options, visitFile, budget, depth + 1)
        : await visitFile(task.path)
    if (!shouldContinue) {
      return false
    }
  }
  if (capacityError) {
    throw capacityError
  }
  return true
}
