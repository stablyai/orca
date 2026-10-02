import type { AiVaultAgent, AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { FileWithMtime } from './session-scanner-types'
import type { SubagentTranscriptPartition } from './session-scanner-subagent-transcripts'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'

export type RemoteOpenCodeSessionReader = Pick<OpenCodeSqliteWorkerClient, 'list' | 'parse'> & {
  dataDirectory: string
  databasePath?: string | null
  parseLegacy: (file: FileWithMtime, platform: NodeJS.Platform) => Promise<AiVaultSession | null>
}

export type RemoteScannerContext = {
  provider: RemoteSessionFilesystemProvider
  executionHostId: ExecutionHostId
  hostPlatform: RemoteHostPlatform
  signal?: AbortSignal
  titleCaches: Map<string, Promise<Map<string, string>>>
  antigravityWorkspaceResolver: AntigravityWorkspaceResolver
}

export type RemoteSessionFilesystemProvider = Pick<
  IFilesystemProvider,
  'readDir' | 'readFile' | 'stat'
> & {
  /** Available only beside the execution host's disk; never opens a client path. */
  readTranscriptBytes?: (path: string, signal?: AbortSignal) => AsyncIterable<Buffer>
  /** Execution-host database access; absent from remote filesystem RPC providers. */
  openCode?: RemoteOpenCodeSessionReader
}

export type RemoteParserOptions = {
  executionHostId: ExecutionHostId
  executionHostPlatform: NodeJS.Platform
}

export type RemoteSessionSource = {
  agent: AiVaultAgent
  rootDir: string
  discover?: (context: RemoteScannerContext, issues: AiVaultScanIssue[]) => Promise<FileWithMtime[]>
  parseCandidate?: (
    file: FileWithMtime,
    context: RemoteScannerContext
  ) => Promise<AiVaultSession | null>
  // Codex sources only: the CODEX_HOME the root belongs to, so bridged or
  // backfilled rollout aliases across remote roots collapse to one canonical row.
  codexHome?: string
  extensions: readonly string[]
  filePredicate?: (path: string) => boolean
  contentDependencyPath?: (path: string) => string
  // Depth 0 denotes a direct child of rootDir.
  directoryPredicate?: (name: string, depth: number) => boolean
  // A canonical file directly beneath every top-level session directory.
  fixedChildFileSegments?: readonly string[]
  // Sibling-subagent layouts (Claude `<session>/subagents/`, OMP's same-named
  // artifact dir): count subagent transcripts from the walked listing and drop
  // them from candidates instead of indexing them as sessions.
  partitionSubagentTranscripts?: (paths: readonly string[]) => SubagentTranscriptPartition
  parseDocument?: (
    file: FileWithMtime,
    bytes: AsyncIterable<Buffer>,
    context: RemoteScannerContext
  ) => Promise<AiVaultSession | null>
  parseLines?: (
    file: FileWithMtime,
    lines: AsyncIterable<string>,
    context: RemoteScannerContext
  ) => Promise<AiVaultSession | null>
  parse: (
    file: FileWithMtime,
    content: string,
    context: RemoteScannerContext
  ) => Promise<AiVaultSession | null>
}

export type RemoteSessionCandidate = {
  source: RemoteSessionSource
  file: FileWithMtime
  subagentTranscriptCount?: number
}
