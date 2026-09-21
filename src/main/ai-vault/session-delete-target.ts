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
import { AI_VAULT_AGENT_SOURCES, isDiscoverableSessionFile } from './session-scanner-agent-sources'
import { subagentTranscriptsDirFor } from './session-scanner-subagent-transcripts'
import type { AiVaultScanOptions } from './session-scanner-types'

// Agents whose session IS the directory holding the scanned file: everything
// beside it belongs to the same session (rovo's session_context.json, grok's
// chat_history.jsonl), so the directory is the only complete delete unit.
const AI_VAULT_DIRECTORY_SHAPED_DELETE_AGENTS = new Set<AiVaultDeletableAgent>([
  'rovo',
  'grok',
  'cline'
])

export type ValidateAiVaultSessionDeleteTargetArgs = {
  agent: AiVaultAgent
  filePath: string
  executionHostId: ExecutionHostId | null | undefined
  // Passed in rather than fetched (getAiVaultWslHomeDirs) so this stays
  // synchronous and pure.
  wslHomeDirs?: readonly string[]
  // Per-agent root overrides so tests never depend on the real home directory.
  rootOptions?: AiVaultScanOptions
}

// Pure path-only judgement: never touches the filesystem, and never throws —
// a malformed or hostile filePath rejects like any other invalid input.
// `allowed: true` alone is NOT enough to delete; see the caller contract on
// AiVaultSessionDeleteAllowedResult.
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
  // Electron shell/fs APIs only act on this computer; an ssh/runtime session's
  // path exists on the remote host. Same limit as Open/Reveal Log.
  if (normalizeExecutionHostId(args.executionHostId) !== LOCAL_EXECUTION_HOST_ID) {
    return rejected(agent, 'non-local-host')
  }
  if (isAiVaultSyntheticSessionPath(filePath)) {
    return rejected(agent, 'synthetic-path')
  }

  // resolve() collapses `..` first: isPathInsideOrEqual compares textually and
  // would otherwise pass `<root>/../../etc/x.jsonl`.
  const resolvedPath = resolve(filePath)
  const source = AI_VAULT_AGENT_SOURCES[agent]
  const roots = source
    .rootDirs(args.rootOptions ?? {}, args.wslHomeDirs ?? [])
    // Why: OMP_CODING_AGENT_DIR='/' normalizes to '', which resolve()s to the
    // process cwd — an empty root would silently allowlist it.
    .filter((rootDir) => rootDir.trim().length > 0)
    .map((rootDir) => resolve(rootDir))
  // Keep the root that actually contains this path: companion roots are derived
  // from it, so a WSL-home session can't pair with the local host's companions.
  const matchedRoot = roots.find((root) => isPathInsideOrEqual(root, resolvedPath))
  if (!matchedRoot) {
    return rejected(agent, 'path-outside-known-roots')
  }
  // The scanner's own accept rule, so a path it would never have surfaced as a
  // session row can't be accepted as a delete target either.
  if (!isDiscoverableSessionFile(source, matchedRoot, resolvedPath)) {
    return rejected(agent, 'undiscoverable-path')
  }

  const removals = sessionDeleteRemovals({ agent, resolvedPath, matchedRoot, roots })
  if (!removals) {
    return rejected(agent, 'no-session-directory')
  }

  return { allowed: true, agent, resolvedPath, removals }
}

// The ordered path set that removing this session means: companions first, the
// scanned path last. Null when the path names no session directory of its own,
// which would otherwise reach the root holding every session.
//
// `session-env/<uuid>/` is a companion — it holds that session's generated
// shell exports and nothing else. Its sibling `file-history/<uuid>/` is
// deliberately NOT: that is the rewind buffer holding earlier versions of the
// user's own files, and retiring a session is no reason to destroy the only
// copy that can restore them.
function sessionDeleteRemovals(args: {
  agent: AiVaultDeletableAgent
  resolvedPath: string
  matchedRoot: string
  roots: readonly string[]
}): readonly AiVaultSessionDeleteRemoval[] | null {
  const { agent, resolvedPath, matchedRoot, roots } = args

  if (AI_VAULT_DIRECTORY_SHAPED_DELETE_AGENTS.has(agent)) {
    const sessionDir = dirname(resolvedPath)
    if (sessionDir === matchedRoot || !isPathInsideOrEqual(matchedRoot, sessionDir)) {
      return null
    }
    return [{ path: sessionDir, kind: 'directory', roots }]
  }

  if (agent === 'claude') {
    const sessionId = basename(resolvedPath, extname(resolvedPath))
    // A degenerate stem ('.' from `..jsonl`, or empty) would resolve the session
    // dir to the project dir and trash every session in it.
    if (!sessionId || sessionId === '.' || sessionId === '..') {
      return null
    }
    // <enc>/<uuid>/, named after the transcript. Taking it rather than just the
    // `subagents/` it holds is what stops an empty <uuid>/ being left behind.
    // Derived from the scanner's subagents path so the two can't drift.
    const sessionDir = dirname(subagentTranscriptsDirFor(resolvedPath))
    // Derived from the matched root, so a WSL-home session cleans up that
    // distro's session-env rather than the local host's.
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
