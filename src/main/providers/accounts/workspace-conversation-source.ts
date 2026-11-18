import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readCodexRolloutSessionMetaId } from '../../codex/history/rollouts/codex-rollout-session-meta'
import { readTranscriptHeadCwd } from '../../ai-vault/scope/session-scope-cwd'
import { normalizeRuntimePathForComparison } from '../../../shared/file-access/cross-platform-path'
import { AI_VAULT_AGENT_SOURCES } from '../../ai-vault/discovery/session-scanner-agent-sources'
import { isDiscoverableSessionFile } from '../../ai-vault/discovery/session-file-discovery'

export async function verifiedWorkspaceConversation(args: {
  provider: 'claude' | 'codex'
  filePath: string
  sessionId: string
  roots: readonly string[]
}): Promise<{ sourceHome: string; historyRoot: string; filePath: string; cwd: string | null }> {
  if (args.sessionId === '.' || args.sessionId === '..' || /[\\/\0]/.test(args.sessionId)) {
    throw new Error('The session identity is not a valid filename segment.')
  }
  const filePath = await realpath(args.filePath)
  const entry = await lstat(filePath)
  if (!entry.isFile()) {
    throw new Error('The session transcript is not a regular file.')
  }
  let sourceHome: string | null = null
  let historyRoot: string | null = null
  let sourcePath = filePath
  const candidates: { home: string; root: string; path: string; logical: boolean }[] = []
  for (const root of args.roots) {
    const physicalRoot = await realpath(root).catch(() => null)
    if (!physicalRoot) {
      continue
    }
    const offset = relative(physicalRoot, filePath)
    if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
      continue
    }
    const home = await realpath(dirname(resolve(root)))
    const logicalRoot = join(home, basename(root))
    const logicalPath = join(logicalRoot, offset)
    if (
      !isDiscoverableSessionFile(AI_VAULT_AGENT_SOURCES[args.provider], logicalRoot, logicalPath)
    ) {
      continue
    }
    const requested = relative(resolve(root), resolve(args.filePath))
    const logical =
      requested !== '' &&
      requested !== '..' &&
      !requested.startsWith(`..${sep}`) &&
      !isAbsolute(requested)
    candidates.push({ home, root: logicalRoot, path: logicalPath, logical })
  }
  const logical = candidates.filter((candidate) => candidate.logical)
  const eligible = logical.length ? logical : candidates
  const homes = new Set(
    eligible.map((candidate) => normalizeRuntimePathForComparison(candidate.home))
  )
  if (homes.size > 1) {
    throw new Error(
      'This shared transcript belongs to several account homes. Choose its source home in History.'
    )
  }
  const selected = eligible[0]
  if (selected) {
    sourceHome = selected.home
    historyRoot = selected.root
    sourcePath = selected.path
  }
  if (!sourceHome || !historyRoot) {
    throw new Error(
      'The transcript is outside the current History scan roots on this host. Refresh History and try again.'
    )
  }
  const identity =
    args.provider === 'codex'
      ? await readCodexRolloutSessionMetaId(filePath)
      : basename(filePath).replace(/\.jsonl$/, '')
  if (identity !== args.sessionId) {
    throw new Error('The session identity does not match its transcript.')
  }
  const cwd = await readTranscriptHeadCwd(
    { path: filePath, mtimeMs: entry.mtimeMs, modifiedAt: entry.mtime.toISOString() },
    {
      cwdOf: (record) =>
        args.provider === 'codex'
          ? record.type === 'session_meta' &&
            typeof record.payload === 'object' &&
            record.payload !== null &&
            'cwd' in record.payload
            ? record.payload.cwd
            : undefined
          : record.cwd,
      firstReadBytes: 64 * 1024
    }
  )
  return { sourceHome, historyRoot, filePath: sourcePath, cwd }
}

export async function assertWorkspaceConversationScope(
  cwd: string | null,
  workspacePath: string
): Promise<void> {
  const workspace = await realpath(workspacePath)
  const actual = cwd ? await realpath(cwd).catch(() => cwd) : null
  if (
    !actual ||
    normalizeRuntimePathForComparison(actual) !== normalizeRuntimePathForComparison(workspace)
  ) {
    throw new Error(
      'This session belongs to another workspace. Open its workspace to continue it across accounts.'
    )
  }
}
