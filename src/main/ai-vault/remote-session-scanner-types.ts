import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { IFilesystemProvider } from '../providers/types'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { FileWithMtime } from './session-scanner-types'
import type { AntigravityWorkspaceResolver } from './session-scanner-antigravity-history'

export type RemoteScannerContext = {
  provider: IFilesystemProvider
  executionHostId: ExecutionHostId
  hostPlatform: RemoteHostPlatform
  titleCaches: Map<string, Promise<Map<string, string>>>
  antigravityWorkspaceResolver: AntigravityWorkspaceResolver
}

export type RemoteParserOptions = {
  executionHostId: ExecutionHostId
  executionHostPlatform: NodeJS.Platform
}

export type RemoteSessionSource = {
  agent: AiVaultAgent
  rootDir: string
  // Codex sources only: the CODEX_HOME the root belongs to, so bridged or
  // backfilled rollout aliases across remote roots collapse to one canonical row.
  codexHome?: string
  extensions: readonly string[]
  filePredicate?: (path: string) => boolean
  // Depth 0 denotes a direct child of rootDir.
  directoryPredicate?: (name: string, depth: number) => boolean
  // A canonical file directly beneath every top-level session directory.
  fixedChildFileSegments?: readonly string[]
  // Claude layout: count `<session>/subagents/*.jsonl` siblings from the walked
  // listing and drop them from candidates instead of indexing them as sessions.
  collectSubagentSiblingCounts?: boolean
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
