import { readdir, stat } from 'node:fs/promises'
import { basename, delimiter, extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function discoverFiles(args: {
  rootDir: string
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
}): Promise<SessionFileDiscovery> {
  const paths = await walkSessionFiles(args.rootDir, args.agent, args.issues, {
    extensions: new Set(args.extensions),
    filePredicate: args.filePredicate
  })
  const files: FileWithMtime[] = []
  for (const path of paths) {
    try {
      const fileStat = await stat(path)
      files.push({
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString()
      })
    } catch (err) {
      args.issues.push({ agent: args.agent, path, message: errorMessage(err) })
    }
  }
  return {
    agent: args.agent,
    rootDir: args.rootDir,
    files: files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, args.limit)
  }
}

export async function discoverOpenClawFiles(args: {
  rootDirs: string[]
  limit: number
  issues: AiVaultScanIssue[]
}): Promise<SessionFileDiscovery> {
  const discoveries = await Promise.all(
    args.rootDirs.map((rootDir) =>
      discoverFiles({
        rootDir: basename(rootDir) === 'agents' ? rootDir : join(rootDir, 'agents'),
        limit: args.limit,
        agent: 'openclaw',
        issues: args.issues,
        extensions: ['.jsonl'],
        filePredicate: (path) => path.split(/[\\/]/).includes('sessions')
      })
    )
  )
  const files = discoveries
    .flatMap((discovery) => discovery.files)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, args.limit)
  return { agent: 'openclaw', rootDir: args.rootDirs.join(delimiter), files }
}

export async function walkSessionFiles(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: {
    extensions: Set<string>
    filePredicate?: (path: string) => boolean
  }
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkSessionFiles(fullPath, agent, issues, options)))
      continue
    }
    if (
      entry.isFile() &&
      options.extensions.has(extname(entry.name).toLowerCase()) &&
      (options.filePredicate?.(fullPath) ?? true)
    ) {
      files.push(fullPath)
    }
  }
  return files
}
