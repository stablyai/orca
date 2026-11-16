import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  isAiVaultDeletableAgent,
  isAiVaultSyntheticSessionPath,
  type AiVaultSessionDeleteRemoval
} from '../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { sessionFileExecutionNamespace } from '../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { AI_VAULT_AGENT_SOURCES } from '../discovery/session-scanner-agent-sources'
import { isDiscoverableSessionFile } from '../discovery/session-file-discovery'
import { validateAiVaultSessionDeleteTarget } from '../deletion/session-delete-target'
import { isENOENT } from '../../filesystem/local-file-io/filesystem-path-containment'
import type { AiVaultScanOptions } from '../session-scanner-types'

export type WorkspaceHistoryRemovalContext = {
  options: AiVaultScanOptions
  wslHomeDirs: readonly string[]
}

/** Every path one session owns, or null when its layout cannot prove what to remove. */
export async function workspaceHistorySessionRemovals(
  session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'>,
  context: WorkspaceHistoryRemovalContext
): Promise<AiVaultSessionDeleteRemoval[] | null> {
  const { agent } = session
  const filePath = resolve(session.filePath)
  if (isAiVaultSyntheticSessionPath(session.filePath)) {
    return null
  }
  if (isAiVaultDeletableAgent(agent)) {
    const validation = validateAiVaultSessionDeleteTarget({
      agent,
      filePath: session.filePath,
      executionHostId: session.executionHostId,
      wslHomeDirs: context.wslHomeDirs,
      rootOptions: context.options
    })
    return validation.allowed ? [...validation.removals] : null
  }
  if (agent === 'antigravity') {
    return antigravityRemovals(filePath)
  }
  if (agent === 'opencode') {
    return openCodeFileRemovals(filePath)
  }
  const source = AI_VAULT_AGENT_SOURCES[agent]
  if (!source) {
    return null
  }
  const roots = source
    .rootDirs(context.options, context.wslHomeDirs)
    .filter((root) => root.trim().length > 0)
    .map((root) => resolve(root))
  const root = roots.find((candidate) => isPathInsideOrEqual(candidate, filePath))
  if (!root || !isDiscoverableSessionFile(source, root, filePath)) {
    return null
  }
  const file = (path: string): AiVaultSessionDeleteRemoval => ({ path, kind: 'file', roots })
  const directory = (path: string): AiVaultSessionDeleteRemoval | null =>
    path !== root && isPathInsideOrEqual(root, path) ? { path, kind: 'directory', roots } : null
  const stem = filePath.slice(0, -extname(filePath).length)
  switch (agent) {
    case 'codex':
      return codexAliasRemovals(filePath, root, roots)
    case 'qoder':
      return [directory(stem), file(filePath)].filter(isRemoval)
    case 'jcode':
      return [file(`${stem}.journal.jsonl`), file(filePath)]
    case 'kiro':
      return [directory(stem), file(`${filePath}l`), file(filePath)].filter(isRemoval)
    case 'muse':
    case 'kimi': {
      const sessionDir = directory(dirname(filePath))
      return sessionDir ? [sessionDir] : null
    }
    case 'prime-agent':
      return [file(filePath)]
    // Database rows are deleted by the SQLite pass, never as files.
    case 'opencode2':
    case 'zcode':
      return null
  }
}

// Codex hard-links one rollout into every home and archives it as a .zst twin; any survivor frees nothing and resurfaces.
function codexAliasRemovals(
  filePath: string,
  matchedRoot: string,
  roots: readonly string[]
): AiVaultSessionDeleteRemoval[] {
  const relativePath = relative(matchedRoot, filePath).replace(/\.zst$/i, '')
  // A native rollout has no links inside WSL homes, and probing them costs a wsl.exe per root.
  const namespace = sessionFileExecutionNamespace(filePath)
  return roots
    .filter((root) => sessionFileExecutionNamespace(root) === namespace)
    .flatMap((root) =>
      [join(root, relativePath), join(root, `${relativePath}.zst`)].map((path) => ({
        path,
        kind: 'file' as const,
        roots: [root]
      }))
    )
}

// <brain>/<id>/.system_generated/logs/transcript.jsonl: the conversation folder holds its artifacts too.
function antigravityRemovals(filePath: string): AiVaultSessionDeleteRemoval[] | null {
  const logsDir = dirname(filePath)
  const generatedDir = dirname(logsDir)
  if (basename(logsDir) !== 'logs' || basename(generatedDir) !== '.system_generated') {
    return null
  }
  const conversationDir = dirname(generatedDir)
  const brainDir = dirname(conversationDir)
  return [{ path: conversationDir, kind: 'directory', roots: [brainDir] }]
}

// <storage>/session/<project>/<id>.json with messages in message/<id>/ and their parts in part/<messageId>/.
async function openCodeFileRemovals(
  filePath: string
): Promise<AiVaultSessionDeleteRemoval[] | null> {
  const sessionRoot = dirname(dirname(filePath))
  if (extname(filePath) !== '.json' || basename(sessionRoot) !== 'session') {
    return null
  }
  const storageRoot = dirname(sessionRoot)
  const sessionId = basename(filePath, '.json')
  const messageDir = join(storageRoot, 'message', sessionId)
  let messageFiles: string[] = []
  try {
    messageFiles = (await readdir(messageDir)).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if (!isENOENT(error)) {
      return null
    }
  }
  const roots = [storageRoot]
  return [
    ...messageFiles.map((name) => ({
      path: join(storageRoot, 'part', basename(name, '.json')),
      kind: 'directory' as const,
      roots
    })),
    { path: messageDir, kind: 'directory', roots },
    { path: filePath, kind: 'file', roots }
  ]
}

function isRemoval(
  removal: AiVaultSessionDeleteRemoval | null
): removal is AiVaultSessionDeleteRemoval {
  return removal !== null
}
