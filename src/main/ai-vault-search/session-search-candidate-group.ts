import { basename, dirname, extname } from 'node:path'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { sessionFileExecutionNamespace } from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { splitOpenCodeSqliteCandidate } from '../../shared/opencode-sqlite-session-path'

export function sessionSearchCandidateGroup(candidate: SessionFileCandidate, root: string): string {
  const path = candidate.file.path
  return candidate.agent === 'codex'
    ? `codex:${sessionFileExecutionNamespace(path)}:${basename(path)}`
    : candidate.agent === 'antigravity'
      ? `antigravity:${dirname(path)}`
      : candidate.agent === 'opencode' ||
          candidate.agent === 'opencode2' ||
          candidate.agent === 'zcode'
        ? `${candidate.agent}:${root}:${splitOpenCodeSqliteCandidate(path, candidate.agent)?.sessionId ?? basename(path, extname(path))}`
        : path
}
