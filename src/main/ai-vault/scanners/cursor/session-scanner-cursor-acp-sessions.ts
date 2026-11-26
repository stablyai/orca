import { basename, dirname, join } from 'node:path'
import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { wslGatedStat } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import {
  cursorAcpSessionMetaPath,
  readCursorAcpSessionMeta
} from './session-scanner-cursor-acp-meta'
import { observeSessionSidecar } from '../../discovery/session-file-observation'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { SessionNewestFiles } from '../../discovery/session-newest-files'
import { isMissingTranscriptPathError } from '../../discovery/session-path-absence'
import { createAccumulator, finalizeSession } from '../../parsing/session-scanner-accumulator'
import { recordSessionScanIssue, scanIssueTextFromError } from '../../parsing/session-scan-issues'
import { throwIfAiVaultScanCancelled } from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  noteAiVaultScanFileFound,
  openAiVaultScanSource
} from '../../scan-lifecycle/ai-vault-scan-progress'
import { scopeWalksAgentFiles } from '../../scope/session-scope-cwd'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from '../../session-scanner-types'

// `cursor-agent acp` keeps each chat in <config dir>/acp-sessions/<sessionId>/: meta.json (cwd,
// title) and store.db (the conversation). History lists a chat by store.db, whose mtime is its
// last activity as Cursor's own session/list reports it, and reads only the sibling meta.json.
const ACP_SESSIONS_DIR = 'acp-sessions'
const NATIVE_STAT_CONCURRENCY = 8
// WSL stats cross the 9P bridge through shared gate slots.
const WSL_STAT_CONCURRENCY = 4

/** Only sessions an Orca chat owns, by path: no directory walk. */
export function cursorAcpDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const owned = options.cursorAcpSessions
  if (!owned) {
    return []
  }
  const idsByRoot = new Map<string, readonly string[]>()
  for (const folder of [
    ...owned.folders.map(({ configDir, sessionIds }) => ({
      rootDir: join(configDir, ACP_SESSIONS_DIR),
      sessionIds
    })),
    ...(owned.wslSessionIds.length > 0
      ? wslHomeDirs.map((home) => ({
          rootDir: join(home, '.cursor', ACP_SESSIONS_DIR),
          sessionIds: owned.wslSessionIds
        }))
      : [])
  ]) {
    idsByRoot.set(folder.rootDir, [...(idsByRoot.get(folder.rootDir) ?? []), ...folder.sessionIds])
  }
  const keepScopeFiles = scopeWalksAgentFiles('cursor', options.scopePaths)
  return [...idsByRoot].map(([rootDir, sessionIds]) =>
    statOwnedSessions({
      rootDir,
      sessionIds,
      limit,
      issues,
      keepScopeFiles,
      signal: options.signal
    })
  )
}

async function statOwnedSessions(args: {
  rootDir: string
  sessionIds: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  keepScopeFiles: boolean
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const { rootDir, signal } = args
  const closeSource = openAiVaultScanSource(signal, 'cursor')
  // One refusal (a stopped or stuck WSL distro) stands for the whole folder, as a walk's would.
  let refused: unknown = null
  try {
    const observed = await mapWithConcurrency(
      args.sessionIds,
      isWslUncPath(rootDir) ? WSL_STAT_CONCURRENCY : NATIVE_STAT_CONCURRENCY,
      async (sessionId) => {
        if (refused) {
          return null
        }
        const path = join(rootDir, sessionId, 'store.db')
        try {
          // meta.json is the row's only source: a missing or rewritten one must force a reparse.
          const [stat, sidecar] = await Promise.all([
            wslGatedStat(path, 'scan', signal),
            observeSessionSidecar(cursorAcpSessionMetaPath(path), signal)
          ])
          return stat.isFile() ? { path, stat, sidecar } : null
        } catch (error) {
          throwIfAiVaultScanCancelled(signal)
          if (error instanceof WslTranscriptFsError) {
            refused ??= error
            return null
          }
          // A chat whose session never wrote here (another folder, or not started yet).
          if (!isMissingTranscriptPathError(error)) {
            recordSessionScanIssue(args.issues, {
              agent: 'cursor',
              path,
              ...scanIssueTextFromError(error)
            })
          }
          return null
        }
      }
    )
    throwIfAiVaultScanCancelled(signal)
    if (refused) {
      recordSessionScanIssue(args.issues, {
        agent: 'cursor',
        path: rootDir,
        ...scanIssueTextFromError(refused)
      })
      return { agent: 'cursor', rootDir, files: [] }
    }
    const files = new SessionNewestFiles(args.limit)
    const scopeFiles: FileWithMtime[] | undefined = args.keepScopeFiles ? [] : undefined
    for (const found of observed) {
      if (!found) {
        continue
      }
      const file: FileWithMtime = {
        path: found.path,
        mtimeMs: found.stat.mtimeMs,
        modifiedAt: new Date(found.stat.mtimeMs).toISOString(),
        sizeBytes: found.stat.size,
        sidecar: found.sidecar,
        dev: found.stat.dev,
        ino: found.stat.ino,
        nlink: found.stat.nlink
      }
      noteAiVaultScanFileFound(signal, 'cursor', file)
      const left = files.add(file)
      if (left) {
        scopeFiles?.push(left)
      }
    }
    return {
      agent: 'cursor',
      rootDir,
      files: files.newest(),
      ...(scopeFiles ? { scopeFiles } : {})
    }
  } finally {
    closeSource()
  }
}

/** A listing row only: the owning chat opens the conversation. */
export async function parseCursorAcpSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const meta = await readCursorAcpSessionMeta(file.path, signal)
  if (!meta) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'cursor',
    file,
    sessionId: basename(dirname(file.path))
  })
  accumulator.cwd = meta.cwd
  accumulator.title = meta.title
  const session = finalizeSession(accumulator, platform)
  // `cursor-agent --resume` reads the terminal store and cannot open an ACP session.
  return session && { ...session, resumeCommand: '' }
}
