import { readdir, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, join } from 'node:path'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault-scope-cwd-match'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  devinDbSessionCandidatePath,
  devinSessionsDbPathInStore,
  readDevinConversation,
  type DevinConversationMessage
} from './session-scanner-devin-db-conversation'
import { recordSessionScanIssue } from './session-scan-issues'
import { createAccumulator, finalizeSession } from './session-scanner-accumulator'
import {
  devinSessionsDbDependencyPath,
  devinSessionsIndexForSidecar
} from './session-scanner-devin-db'
import { consumeDevinSessionStep } from './session-scanner-devin-parser'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'

export { splitDevinDbSessionCandidate } from './session-scanner-devin-db-conversation'

const TRANSCRIPT_DIRS = ['transcripts', 'agent_logs'] as const

export function devinDbDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  // SQLite over a WSL UNC path can stall the scan; transcripts still list.
  const transcriptRoots = (
    AI_VAULT_AGENT_SOURCES.devin?.rootDirs(options, wslHomeDirs) ?? []
  ).filter((root) => !isWslUncPath(root))
  return [
    discoverDevinDbSessions({
      transcriptRoots,
      limit,
      issues,
      scopePaths: options.scopePaths,
      signal: options.signal
    })
  ]
}

/** Lists sessions with no ATIF export, which the transcript walk cannot see. */
export async function discoverDevinDbSessions(args: {
  transcriptRoots: readonly string[]
  limit: number
  issues: AiVaultScanIssue[]
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const cliDirs = [...new Set(args.transcriptRoots.map((root) => dirname(root)))]
  const files: FileWithMtime[] = []
  const scopeFiles: FileWithMtime[] = []
  const inScope = args.scopePaths?.length ? createAiVaultScopeCwdMatcher(args.scopePaths) : null
  for (const cliDir of cliDirs) {
    throwIfSignalAborted(args.signal)
    const dbPath = devinSessionsDbPathInStore(cliDir)
    // Shares transcript enrichment's index so a contended database is tried once per scan.
    const sidecarPath = await devinSessionsDbDependencyPath(join(cliDir, 'transcripts', 'x.json'))
    const sidecar = await stat(sidecarPath).catch(() => null)
    if (!sidecar?.isFile()) {
      continue
    }
    const { index, unreadable } = devinSessionsIndexForSidecar({
      path: sidecarPath,
      mtimeMs: sidecar.mtimeMs,
      sizeBytes: sidecar.size
    })
    if (!index) {
      if (unreadable) {
        recordSessionScanIssue(args.issues, {
          agent: 'devin',
          path: dbPath,
          message: 'Devin sessions database is unreadable'
        })
      }
      continue
    }
    const exported = await exportedSessionIds(cliDir)
    for (const [id, row] of index) {
      const mtimeMs = row.lastActivityAt ? Date.parse(row.lastActivityAt) : Number.NaN
      if (row.hidden || exported.has(id) || !Number.isFinite(mtimeMs)) {
        continue
      }
      const file = {
        path: devinDbSessionCandidatePath(cliDir, id),
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString()
      }
      files.push(file)
      if (inScope?.(row.workingDirectory, dbPath)) {
        scopeFiles.push(file)
      }
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return {
    agent: 'devin',
    rootDir: cliDirs.join(delimiter),
    files: files.slice(0, args.limit),
    ...(inScope ? { scopeFiles } : {})
  }
}

async function exportedSessionIds(cliDir: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const dir of TRANSCRIPT_DIRS) {
    const names = await readdir(join(cliDir, dir)).catch(() => [])
    for (const name of names) {
      if (extname(name) === '.json') {
        ids.add(basename(name, '.json'))
      }
    }
  }
  return ids
}

export function parseDevinDbSession(
  candidate: { dbPath: string; sessionId: string },
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const conversation = readDevinConversation(candidate.dbPath, candidate.sessionId)
  if (!conversation) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'devin',
    file,
    sessionId: candidate.sessionId,
    messages
  })
  accumulator.cwd = conversation.workingDirectory
  accumulator.model = conversation.model
  for (const message of conversation.messages) {
    consumeDevinSessionStep(accumulator, devinMessageStep(message))
  }
  accumulator.title = conversation.title ?? accumulator.title
  return finalizeSession(accumulator, platform, {})
}

/** An ATIF-shaped step, so database and transcript sessions share one step reader. */
function devinMessageStep(message: DevinConversationMessage): Record<string, unknown> {
  return {
    source: message.role === 'user' ? 'user' : 'agent',
    message: [
      { type: 'text', text: message.content },
      ...message.toolCalls.map((call) => ({ type: 'tool_use', name: call.name, input: call.input }))
    ],
    ...(message.createdAtMs ? { timestamp: new Date(message.createdAtMs).toISOString() } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {})
  }
}
