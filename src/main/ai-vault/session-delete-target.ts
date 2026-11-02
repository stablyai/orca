import { basename, dirname, extname, join, resolve } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import {
  isAiVaultDeletableAgent,
  isAiVaultSyntheticSessionPath,
  type AiVaultDeletableAgent,
  type AiVaultSessionDeleteRejectionCode,
  type AiVaultSessionDeleteRemoval,
  type AiVaultSessionDeleteValidationResult
} from '../../shared/ai-vault-session-deletion'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  AI_VAULT_AGENT_SOURCES,
  isDiscoverableSessionFile,
  sessionRowRootDirs
} from './session-scanner-agent-sources'
import { subagentTranscriptsDirFor } from './session-scanner-subagent-transcripts'
import type { AiVaultScanOptions } from './session-scanner-types'

// These sessions own their containing directory, including companion files.
const AI_VAULT_WHOLE_DIRECTORY_DELETE_AGENTS = new Set<AiVaultDeletableAgent>([
  'rovo',
  'grok',
  'cline'
])

export type ValidateAiVaultSessionDeleteTargetArgs = {
  agent: AiVaultAgent
  filePath: string
  executionHostId: ExecutionHostId | null | undefined
  // Supply WSL roots to keep validation synchronous.
  wslHomeDirs?: readonly string[]
  rootOptions?: AiVaultScanOptions
}

// Path approval still requires filesystem containment checks before removal.
export function validateAiVaultSessionDeleteTarget(
  args: ValidateAiVaultSessionDeleteTargetArgs
): AiVaultSessionDeleteValidationResult {
  const { agent } = args
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
  if (!filePath) {
    return rejected(agent, 'invalid-path')
  }
  if (!isAiVaultDeletableAgent(agent)) {
    return rejected(agent, 'unsupported-agent')
  }
  // Electron removal acts only on this host; remote paths require their own execution host.
  if (normalizeExecutionHostId(args.executionHostId) !== LOCAL_EXECUTION_HOST_ID) {
    return rejected(agent, 'non-local-host')
  }
  if (isAiVaultSyntheticSessionPath(filePath)) {
    return rejected(agent, 'synthetic-path')
  }

  // Collapse traversal before textual containment checks.
  const resolvedPath = resolve(filePath)
  const source = AI_VAULT_AGENT_SOURCES[agent]
  const roots = sessionRowRootDirs(agent, args.rootOptions ?? {}, args.wslHomeDirs ?? [])
    // An empty root resolves to cwd and would silently allowlist it.
    .filter((rootDir) => rootDir.trim().length > 0)
    .map((rootDir) => resolve(rootDir))
  // Match companion roots to this transcript's host, including WSL distros.
  const matchedRoot = roots.find((root) => isPathInsideOrEqual(root, resolvedPath))
  if (!matchedRoot) {
    return rejected(agent, 'path-outside-known-roots')
  }
  // Deletion must accept only paths the scanner could discover.
  if (!isDiscoverableSessionFile(source, matchedRoot, resolvedPath)) {
    return rejected(agent, 'undiscoverable-path')
  }

  const removals = sessionDeleteRemovals({ agent, resolvedPath, matchedRoot, roots })
  if (!removals) {
    return rejected(agent, 'no-session-directory')
  }

  return { allowed: true, agent, resolvedPath, removals }
}

// Remove companions before the transcript; preserve file-history rewind backups of the user's files.
function sessionDeleteRemovals(args: {
  agent: AiVaultDeletableAgent
  resolvedPath: string
  matchedRoot: string
  roots: readonly string[]
}): readonly AiVaultSessionDeleteRemoval[] | null {
  const { agent, resolvedPath, matchedRoot, roots } = args

  if (AI_VAULT_WHOLE_DIRECTORY_DELETE_AGENTS.has(agent)) {
    const sessionDir = dirname(resolvedPath)
    if (sessionDir === matchedRoot || !isPathInsideOrEqual(matchedRoot, sessionDir)) {
      return null
    }
    return [{ path: sessionDir, kind: 'directory', roots }]
  }

  if (agent === 'claude') {
    const sessionId = basename(resolvedPath, extname(resolvedPath))
    // Empty or dot stems would resolve to a project directory containing other sessions.
    if (!sessionId || sessionId === '.' || sessionId === '..') {
      return null
    }
    // Reuse the scanner's companion layout and remove the enclosing session directory too.
    const sessionDir = dirname(subagentTranscriptsDirFor(resolvedPath))
    // Use this distro's session-env, never the local host's.
    const sessionEnvRoot = join(dirname(matchedRoot), 'session-env')
    return [
      { path: sessionDir, kind: 'directory', roots },
      { path: join(sessionEnvRoot, sessionId), kind: 'directory', roots: [sessionEnvRoot] },
      { path: resolvedPath, kind: 'file', roots }
    ]
  }

  return [{ path: resolvedPath, kind: 'file', roots }]
}

function rejected(
  agent: AiVaultAgent,
  reason: AiVaultSessionDeleteRejectionCode
): AiVaultSessionDeleteValidationResult {
  return { allowed: false, agent, reason }
}
