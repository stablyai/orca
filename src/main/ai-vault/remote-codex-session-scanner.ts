import { extname } from 'node:path'
import type { AiVaultListResult, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { IFilesystemProvider, FileStat } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import { parseCodexSessionContent } from './session-scanner-codex-parser'
import type { FileWithMtime } from './session-scanner-types'
import {
  errorMessage,
  extractString,
  normalizeTitleText,
  parseJsonObject
} from './session-scanner-values'
import { sessionSortTime } from './session-scanner-accumulator'

const DEFAULT_REMOTE_SCAN_LIMIT = 1000
const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

export async function scanRemoteCodexSessions(args: {
  provider: IFilesystemProvider
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
}): Promise<AiVaultListResult> {
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_REMOTE_SCAN_LIMIT
  const issues: AiVaultScanIssue[] = []
  const roots = remoteCodexRoots(args.remoteHome, args.hostPlatform)
  const titleCaches = new Map<string, Promise<Map<string, string>>>()
  const files = (
    await Promise.all(
      roots.map(async (root) => {
        const paths = await walkRemoteJsonlFiles({
          provider: args.provider,
          dirPath: root.sessionsDir,
          hostPlatform: args.hostPlatform,
          issues,
          executionHostId: args.executionHostId
        })
        const withMtime = await Promise.all(
          paths.map((path) => statRemoteFile(args.provider, path, args.executionHostId, issues))
        )
        return withMtime
          .filter((file): file is FileWithMtime => Boolean(file))
          .map((file) => ({ file, codexHome: root.codexHome }))
      })
    )
  )
    .flat()
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
    .slice(0, limit)

  const sessions = (
    await Promise.all(
      files.map(async ({ file, codexHome }) => {
        try {
          const read = await args.provider.readFile(file.path)
          if (read.isBinary) {
            return null
          }
          return parseCodexSessionContent({
            file,
            content: read.content,
            platform: args.hostPlatform.os,
            codexHome,
            executionHostId: args.executionHostId,
            readIndexedTitle: async (sessionId) => {
              const titleBySessionId = await remoteCodexIndexTitles({
                provider: args.provider,
                codexHome,
                hostPlatform: args.hostPlatform,
                titleCaches
              })
              return titleBySessionId.get(sessionId) ?? null
            }
          })
        } catch (err) {
          issues.push({
            executionHostId: args.executionHostId,
            agent: 'codex',
            path: file.path,
            message: errorMessage(err)
          })
          return null
        }
      })
    )
  )
    .filter((session): session is NonNullable<typeof session> => Boolean(session))
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, limit)

  return {
    sessions,
    issues,
    scannedAt: new Date().toISOString()
  }
}

function remoteCodexRoots(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): {
  codexHome: string
  sessionsDir: string
}[] {
  const defaultCodexHome = joinRemotePath(hostPlatform, remoteHome, '.codex')
  const managedCodexHome = joinRemotePath(
    hostPlatform,
    remoteHome,
    '.local',
    'share',
    'orca',
    'codex-runtime-home',
    'home'
  )
  return [
    {
      codexHome: defaultCodexHome,
      sessionsDir: joinRemotePath(hostPlatform, defaultCodexHome, 'sessions')
    },
    {
      codexHome: managedCodexHome,
      sessionsDir: joinRemotePath(hostPlatform, managedCodexHome, 'sessions')
    }
  ]
}

async function walkRemoteJsonlFiles(args: {
  provider: IFilesystemProvider
  dirPath: string
  hostPlatform: RemoteHostPlatform
  executionHostId: ExecutionHostId
  issues: AiVaultScanIssue[]
}): Promise<string[]> {
  let entries
  try {
    entries = await args.provider.readDir(args.dirPath)
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = joinRemotePath(args.hostPlatform, args.dirPath, entry.name)
    if (entry.isDirectory) {
      files.push(...(await walkRemoteJsonlFiles({ ...args, dirPath: fullPath })))
      continue
    }
    if (!entry.isSymlink && extname(entry.name).toLowerCase() === '.jsonl') {
      files.push(fullPath)
    }
  }
  return files
}

async function statRemoteFile(
  provider: IFilesystemProvider,
  path: string,
  executionHostId: ExecutionHostId,
  issues: AiVaultScanIssue[]
): Promise<FileWithMtime | null> {
  try {
    const stat = await provider.stat(path)
    const mtimeMs = remoteStatMtimeMs(stat)
    return {
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    }
  } catch (err) {
    issues.push({
      executionHostId,
      agent: 'codex',
      path,
      message: errorMessage(err)
    })
    return null
  }
}

function remoteStatMtimeMs(stat: FileStat): number {
  if (typeof stat.mtimeMs === 'number' && Number.isFinite(stat.mtimeMs)) {
    return stat.mtimeMs
  }
  return stat.mtime > 10_000_000_000 ? stat.mtime : stat.mtime * 1000
}

async function remoteCodexIndexTitles(args: {
  provider: IFilesystemProvider
  codexHome: string
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
}): Promise<Map<string, string>> {
  const cached = args.titleCaches.get(args.codexHome)
  if (cached) {
    return cached
  }
  const pending = readRemoteCodexIndexTitles(args.provider, args.codexHome, args.hostPlatform)
  args.titleCaches.set(args.codexHome, pending)
  return pending
}

async function readRemoteCodexIndexTitles(
  provider: IFilesystemProvider,
  codexHome: string,
  hostPlatform: RemoteHostPlatform
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    const { content, isBinary } = await provider.readFile(
      joinRemotePath(hostPlatform, codexHome, CODEX_SESSION_INDEX_FILE)
    )
    if (isBinary) {
      return titleBySessionId
    }
    for (const line of content.split(/\r?\n/)) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch {
    // Codex indexes are opportunistic; raw transcripts remain sufficient.
  }
  return titleBySessionId
}
